// Zero-dependency pure-Node streaming .tar.gz / POSIX ustar + pax parser and deterministic builder.
// Enforces hard security boundaries: rejects `..` path traversal, absolute paths, NUL bytes,
// symlinks ('2'), hardlinks ('1'), and device nodes (no artificial 100 MB archive size limit).

import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';
import { MAX_TARBALL_BYTES } from './constants.mjs';

export const MAX_RETAINED_BINARY_ASSET_BYTES = 4 * 1024 * 1024; // 4 MB
const RETAINED_TEXT_OR_CODE_EXT_RE =
  /\.(?:json|jsonc|md|markdown|yml|yaml|mjs|cjs|js|ts|tsx|jsx|py|sh|ps1|cmd|bat|go|rs|txt)$/i;
const RETAINED_SPECIAL_BASENAME_RE =
  /^(?:plugin\.json|agy-market\.json|package\.json|mcp_config\.json|hooks\.json|sidecars\.json|sidecar\.json|skill\.md|readme.*|license.*|copying.*)$/i;

/**
 * Determines whether an archive entry's full Buffer payload needs to be retained in memory
 * for manifest/README/script/icon/rule static inspection, or can be omitted (>4 MB binary assets).
 */
export function shouldRetainArchiveEntryBuffer(relPath, byteSize) {
  if (!Number.isFinite(byteSize) || byteSize <= MAX_RETAINED_BINARY_ASSET_BYTES) {
    return true;
  }
  const norm = String(relPath || '').replace(/\\/g, '/');
  const base = norm.split('/').pop() || '';
  if (RETAINED_SPECIAL_BASENAME_RE.test(base)) return true;
  if (RETAINED_TEXT_OR_CODE_EXT_RE.test(norm)) return true;
  return false;
}

function readCleanString(buf, start, length) {
  const sub = buf.subarray(start, start + length);
  const nul = sub.indexOf(0);
  return (nul === -1 ? sub : sub.subarray(0, nul)).toString('utf8');
}

function parseTarOctal(buf, start, length) {
  // Handle base-256 binary extension if high bit set
  if ((buf[start] & 0x80) !== 0) {
    let val = 0n;
    for (let i = start + 1; i < start + length; i++) {
      val = (val << 8n) | BigInt(buf[i]);
    }
    return Number(val);
  }
  const str = readCleanString(buf, start, length).trim();
  if (!str) return 0;
  const parsed = parseInt(str, 8);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`ERR_TAR_CORRUPT: Invalid octal header value "${str}"`);
  }
  return parsed;
}

export function parsePaxRecords(buf) {
  const attrs = {};
  let offset = 0;
  while (offset < buf.length) {
    const sp = buf.indexOf(0x20, offset); // ASCII space ' '
    if (sp === -1) break;
    const len = parseInt(buf.subarray(offset, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= sp - offset + 1 || offset + len > buf.length) break;
    let recordEnd = offset + len;
    if (buf[recordEnd - 1] === 0x0a) recordEnd -= 1; // strip trailing '\n'
    const record = buf.subarray(sp + 1, recordEnd).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1) {
      attrs[record.slice(0, eq)] = record.slice(eq + 1);
    }
    offset += len;
  }
  return attrs;
}

export function validateSafeArchivePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('ERR_TAR_UNSAFE_PATH: Empty entry path');
  }
  if (rawPath.includes('\0')) {
    throw new Error('ERR_TAR_UNSAFE_PATH: NUL byte in entry path');
  }
  const normalized = rawPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`ERR_TAR_UNSAFE_PATH: Absolute archive path prohibited ("${rawPath}")`);
  }
  const rawSegments = normalized.split('/');
  const cleanSegments = [];
  for (const seg of rawSegments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      throw new Error(`ERR_TAR_PATH_TRAVERSAL: Parent traversal ".." prohibited ("${rawPath}")`);
    }
    cleanSegments.push(seg);
  }
  return cleanSegments.join('/');
}

function createTarEntryAccumulator({ allowExternalSymlinks = false } = {}) {
  const rawFiles = new Map();
  const rawFileSizes = new Map();
  const rawSymlinks = [];
  const omittedBinaryPaths = [];

  let nextPax = {};
  let globalPax = {};
  let nextLongName = '';
  let nextLongLink = '';
  let uncompressedBytes = 0;

  const headerBuf = Buffer.alloc(512);
  let headerFilled = 0;
  let mode = 'HEADER';
  let entryType = 'skip';
  let entryPath = '';
  let entrySize = 0;
  let retainContent = false;
  let entryChunks = [];
  let remaining = 0;
  let paddingRemaining = 0;

  function finalizeEntry() {
    if (entryType === 'skip') {
      entryChunks = [];
      return;
    }
    const payload =
      retainContent && entryChunks.length > 0
        ? entryChunks.length === 1
          ? entryChunks[0]
          : Buffer.concat(entryChunks, entrySize)
        : Buffer.alloc(0);
    entryChunks = [];

    if (entryType === 'pax') {
      nextPax = parsePaxRecords(payload);
    } else if (entryType === 'global_pax') {
      globalPax = { ...globalPax, ...parsePaxRecords(payload) };
    } else if (entryType === 'long_name') {
      nextLongName = readCleanString(payload, 0, payload.length);
    } else if (entryType === 'long_link') {
      nextLongLink = readCleanString(payload, 0, payload.length);
    } else if (entryType === 'file') {
      rawFiles.set(entryPath, payload);
      rawFileSizes.set(entryPath, entrySize);
      if (!retainContent && entrySize > 0) {
        omittedBinaryPaths.push(entryPath);
      }
    }
  }

  function processHeader() {
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (headerBuf[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) return;

    const namePart = readCleanString(headerBuf, 0, 100);
    const prefixPart = readCleanString(headerBuf, 345, 155);
    const linkNamePart = readCleanString(headerBuf, 157, 100);
    const typeFlagChar = headerBuf[156] === 0 ? '0' : String.fromCharCode(headerBuf[156]);
    let size = parseTarOctal(headerBuf, 124, 12);
    if (nextPax.size !== undefined) {
      size = Number(nextPax.size);
    }
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`ERR_TAR_CORRUPT: Invalid tar entry size "${size}"`);
    }

    entrySize = size;
    remaining = size;
    paddingRemaining = (512 - (size % 512)) % 512;
    entryChunks = [];
    entryPath = '';

    if (typeFlagChar === 'x' || typeFlagChar === 'X') {
      entryType = 'pax';
      retainContent = true;
    } else if (typeFlagChar === 'g') {
      entryType = 'global_pax';
      retainContent = true;
    } else if (typeFlagChar === 'L') {
      entryType = 'long_name';
      retainContent = true;
    } else if (typeFlagChar === 'K') {
      entryType = 'long_link';
      retainContent = true;
    } else {
      const mergedPax = { ...globalPax, ...nextPax };
      nextPax = {};

      const rawEntryName =
        nextLongName ||
        mergedPax.path ||
        (prefixPart ? `${prefixPart}/${namePart}` : namePart);
      nextLongName = '';

      const rawLinkTarget = nextLongLink || mergedPax.linkpath || linkNamePart || '';
      nextLongLink = '';

      // Hard-block symlinks & hardlinks unless caller explicitly requests scoped external-symlink collection
      if (typeFlagChar === '1' || typeFlagChar === '2') {
        if (!allowExternalSymlinks) {
          throw new Error(`ERR_TAR_SYMLINK_FORBIDDEN: Archive entry "${rawEntryName}" is a link (typeflag=${typeFlagChar})`);
        }
        const safeLinkPath = validateSafeArchivePath(rawEntryName);
        if (safeLinkPath) {
          rawSymlinks.push({
            path: safeLinkPath,
            target: rawLinkTarget,
            typeflag: typeFlagChar,
          });
        }
        entryType = 'skip';
        retainContent = false;
      } else if (typeFlagChar !== '0' && typeFlagChar !== '5') {
        throw new Error(`ERR_TAR_UNSUPPORTED_TYPE: Archive entry "${rawEntryName}" has disallowed typeflag "${typeFlagChar}"`);
      } else {
        const safePath = validateSafeArchivePath(rawEntryName);
        if (!safePath || typeFlagChar === '5' || rawEntryName.endsWith('/')) {
          entryType = 'skip';
          retainContent = false;
        } else {
          entryType = 'file';
          entryPath = safePath;
          retainContent = shouldRetainArchiveEntryBuffer(safePath, size);
        }
      }
    }

    if (remaining > 0) {
      mode = 'PAYLOAD';
    } else {
      finalizeEntry();
      mode = paddingRemaining > 0 ? 'PADDING' : 'HEADER';
    }
  }

  return {
    get uncompressedBytes() {
      return uncompressedBytes;
    },
    push(chunk) {
      if (!chunk || chunk.length === 0) return;
      uncompressedBytes += chunk.length;
      let pos = 0;
      while (pos < chunk.length) {
        if (mode === 'HEADER') {
          const take = Math.min(512 - headerFilled, chunk.length - pos);
          chunk.copy(headerBuf, headerFilled, pos, pos + take);
          headerFilled += take;
          pos += take;
          if (headerFilled === 512) {
            headerFilled = 0;
            processHeader();
          }
        } else if (mode === 'PAYLOAD') {
          const take = Math.min(remaining, chunk.length - pos);
          if (retainContent) {
            entryChunks.push(Buffer.from(chunk.subarray(pos, pos + take)));
          }
          remaining -= take;
          pos += take;
          if (remaining === 0) {
            finalizeEntry();
            mode = paddingRemaining > 0 ? 'PADDING' : 'HEADER';
          }
        } else if (mode === 'PADDING') {
          const skip = Math.min(paddingRemaining, chunk.length - pos);
          paddingRemaining -= skip;
          pos += skip;
          if (paddingRemaining === 0) {
            mode = 'HEADER';
          }
        }
      }
    },
    finish() {
      if (mode === 'PAYLOAD' && remaining > 0) {
        throw new Error('ERR_TAR_TRUNCATED: Unexpected EOF inside tar entry payload');
      }
      return {
        uncompressedBytes,
        rawFiles,
        rawFileSizes,
        rawSymlinks,
        omittedBinaryPaths,
      };
    },
  };
}

function finalizeTarInspection({
  sha256,
  compressedBytes,
  uncompressedBytes,
  rawFiles,
  rawFileSizes,
  rawSymlinks,
  omittedBinaryPaths,
  stripSingleTopDir = true,
}) {
  // Normalize optional single top-level wrapper folder (e.g. `package/plugin.json` or `my-plugin-1.0.0/plugin.json`)
  // ONLY when `plugin.json` is not already at the archive root.
  let files = rawFiles;
  let fileSizes = rawFileSizes;
  let symlinkPaths = rawSymlinks;
  let finalOmittedPaths = omittedBinaryPaths;
  let strippedRoot = '';

  if (stripSingleTopDir && !rawFiles.has('plugin.json') && rawFiles.size > 0) {
    const firstSegments = new Set();
    let allNested = true;
    for (const p of rawFiles.keys()) {
      const slash = p.indexOf('/');
      if (slash === -1) {
        allNested = false;
        break;
      }
      firstSegments.add(p.slice(0, slash));
    }
    if (allNested) {
      for (const s of rawSymlinks) {
        const slash = s.path.indexOf('/');
        if (slash === -1) {
          allNested = false;
          break;
        }
        firstSegments.add(s.path.slice(0, slash));
      }
    }
    if (allNested && firstSegments.size === 1) {
      const [onlyRoot] = firstSegments;
      strippedRoot = onlyRoot;
      const rootPrefix = `${onlyRoot}/`;
      files = new Map();
      fileSizes = new Map();
      for (const [p, buf] of rawFiles.entries()) {
        const strippedPath = p.slice(rootPrefix.length);
        files.set(strippedPath, buf);
        fileSizes.set(strippedPath, rawFileSizes.get(p) ?? buf.length);
      }
      symlinkPaths = rawSymlinks.map((s) => ({
        ...s,
        path: s.path.startsWith(rootPrefix) ? s.path.slice(rootPrefix.length) : s.path,
      }));
      finalOmittedPaths = omittedBinaryPaths.map((p) =>
        p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : p,
      );
    }
  }

  return {
    sha256,
    compressedBytes,
    uncompressedBytes,
    strippedRoot,
    files,
    fileSizes,
    omittedBinaryPaths: finalOmittedPaths,
    symlinkPaths,
    rawPaths: [...rawFiles.keys()],
  };
}

function* iterBufferChunks(buf, chunkSize = 64 * 1024) {
  for (let off = 0; off < buf.length; off += chunkSize) {
    yield buf.subarray(off, Math.min(buf.length, off + chunkSize));
  }
}

/**
 * Inspect a .tar.gz / .tgz buffer in memory without writing to disk or executing anything.
 * Enforces size caps ONLY when caller passes a finite positive limit (`> 0`).
 * Never passes `Infinity` or `0` to `gunzipSync({ maxOutputLength })` (Node 24 throws `ERR_OUT_OF_RANGE`).
 * Omits large (>4 MB) non-text binary asset Buffers from memory while preserving `fileSizes` metadata.
 */
export function inspectTarGzBuffer(
  compressedBuf,
  {
    maxCompressedBytes = MAX_TARBALL_BYTES,
    maxUncompressedBytes = MAX_TARBALL_BYTES,
    stripSingleTopDir = true,
    allowExternalSymlinks = false,
  } = {},
) {
  if (!Buffer.isBuffer(compressedBuf)) {
    throw new Error('ERR_TAR_INPUT: Expected Buffer');
  }
  if (compressedBuf.length === 0) {
    throw new Error('ERR_TAR_EMPTY: Empty archive');
  }
  const hasCompressedLimit = Number.isFinite(maxCompressedBytes) && maxCompressedBytes > 0;
  if (hasCompressedLimit && compressedBuf.length > maxCompressedBytes) {
    throw new Error(`ERR_TAR_TOO_LARGE: Compressed size ${compressedBuf.length} exceeds ${maxCompressedBytes}`);
  }

  const hasUncompressedLimit = Number.isFinite(maxUncompressedBytes) && maxUncompressedBytes > 0;
  const sha256 = createHash('sha256').update(compressedBuf).digest('hex');
  let tarBuf;
  try {
    tarBuf = gunzipSync(
      compressedBuf,
      hasUncompressedLimit ? { maxOutputLength: maxUncompressedBytes } : undefined,
    );
  } catch (err) {
    if (hasUncompressedLimit && /Cannot create a Buffer|maxOutputLength|ERR_BUFFER_TOO_LARGE/i.test(String(err?.message))) {
      throw new Error(`ERR_TAR_DECOMPRESS_LIMIT: Uncompressed size exceeds ${maxUncompressedBytes}`);
    }
    throw new Error(`ERR_TAR_GZIP_INVALID: ${err?.message || String(err)}`);
  }

  const parser = createTarEntryAccumulator({ allowExternalSymlinks });
  parser.push(tarBuf);
  const parsed = parser.finish();
  return finalizeTarInspection({
    sha256,
    compressedBytes: compressedBuf.length,
    ...parsed,
    stripSingleTopDir,
  });
}

/**
 * Asynchronous streaming `.tar.gz` / `.tgz` inspector using `zlib.createGunzip()`.
 * Avoids materializing a full uncompressed tar Buffer in RAM so multi-hundred-MB / GB+ plugins
 * can be validated in bounded memory.
 */
export async function inspectTarGzStream(
  source,
  {
    maxCompressedBytes = MAX_TARBALL_BYTES,
    maxUncompressedBytes = MAX_TARBALL_BYTES,
    stripSingleTopDir = true,
    allowExternalSymlinks = false,
  } = {},
) {
  const hasCompressedLimit = Number.isFinite(maxCompressedBytes) && maxCompressedBytes > 0;
  const hasUncompressedLimit = Number.isFinite(maxUncompressedBytes) && maxUncompressedBytes > 0;

  let sourceStream;
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    const buf = Buffer.isBuffer(source) ? source : Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    if (buf.length === 0) {
      throw new Error('ERR_TAR_EMPTY: Empty archive');
    }
    if (hasCompressedLimit && buf.length > maxCompressedBytes) {
      throw new Error(`ERR_TAR_TOO_LARGE: Compressed size ${buf.length} exceeds ${maxCompressedBytes}`);
    }
    sourceStream = Readable.from(iterBufferChunks(buf));
  } else if (source && typeof source.getReader === 'function') {
    sourceStream = Readable.fromWeb(source);
  } else if (source && typeof source.pipe === 'function') {
    sourceStream = source;
  } else {
    throw new Error('ERR_TAR_INPUT: Expected Buffer, Uint8Array, Readable, or ReadableStream');
  }

  const hash = createHash('sha256');
  let compressedBytes = 0;

  const counterTransform = new Transform({
    transform(chunk, _enc, cb) {
      compressedBytes += chunk.length;
      if (hasCompressedLimit && compressedBytes > maxCompressedBytes) {
        cb(new Error(`ERR_TAR_TOO_LARGE: Compressed size ${compressedBytes} exceeds ${maxCompressedBytes}`));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  const gunzip = createGunzip();
  const parser = createTarEntryAccumulator({ allowExternalSymlinks });

  sourceStream.on('error', (err) => gunzip.destroy(err));
  counterTransform.on('error', (err) => gunzip.destroy(err));
  sourceStream.pipe(counterTransform).pipe(gunzip);

  try {
    for await (const decompChunk of gunzip) {
      if (hasUncompressedLimit && parser.uncompressedBytes + decompChunk.length > maxUncompressedBytes) {
        throw new Error(`ERR_TAR_DECOMPRESS_LIMIT: Uncompressed size exceeds ${maxUncompressedBytes}`);
      }
      parser.push(decompChunk);
    }
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.startsWith('ERR_TAR_')) {
      throw err;
    }
    if (hasUncompressedLimit && /Cannot create a Buffer|maxOutputLength|ERR_BUFFER_TOO_LARGE/i.test(msg)) {
      throw new Error(`ERR_TAR_DECOMPRESS_LIMIT: Uncompressed size exceeds ${maxUncompressedBytes}`);
    }
    throw new Error(`ERR_TAR_GZIP_INVALID: ${msg}`);
  } finally {
    if (typeof sourceStream.destroy === 'function') sourceStream.destroy();
    counterTransform.destroy();
    gunzip.destroy();
  }

  if (compressedBytes === 0) {
    throw new Error('ERR_TAR_EMPTY: Empty archive');
  }

  const parsed = parser.finish();
  return finalizeTarInspection({
    sha256: hash.digest('hex'),
    compressedBytes,
    ...parsed,
    stripSingleTopDir,
  });
}

function writeOctalField(buf, strVal, offset, length) {
  const oct = strVal.padStart(length - 1, '0');
  buf.write(oct, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function createUstarHeader(relPath, byteLength, { mode = 0o644, mtime = 0, typeflag = '0' } = {}) {
  const header = Buffer.alloc(512, 0);
  const safe = validateSafeArchivePath(relPath);
  let name = safe;
  let prefix = '';

  if (Buffer.byteLength(safe, 'utf8') > 100) {
    const slashIdx = safe.lastIndexOf('/');
    if (slashIdx === -1) {
      throw new Error(`Filename exceeds 100 bytes without directory prefix: ${safe}`);
    }
    prefix = safe.slice(0, slashIdx);
    name = safe.slice(slashIdx + 1);
    if (Buffer.byteLength(prefix, 'utf8') > 155 || Buffer.byteLength(name, 'utf8') > 100) {
      throw new Error(`Path exceeds POSIX ustar 255-byte limit: ${safe}`);
    }
  }

  header.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8');
  writeOctalField(header, mode.toString(8), 100, 8);
  writeOctalField(header, '0', 108, 8); // uid
  writeOctalField(header, '0', 116, 8); // gid
  writeOctalField(header, byteLength.toString(8), 124, 12);
  writeOctalField(header, mtime.toString(8), 136, 12);

  // Checksum placeholder (8 spaces)
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix) {
    header.write(prefix, 345, Math.min(155, Buffer.byteLength(prefix)), 'utf8');
  }

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const chk = sum.toString(8).padStart(6, '0');
  header.write(chk, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/**
 * Deterministic POSIX ustar .tar.gz builder (sorted paths, mtime=0, gzip OS=3).
 * `entries`: Record<string, string | Buffer> or Map<string, string | Buffer>.
 */
export function createTarGzBuffer(entries) {
  const pairs = entries instanceof Map ? [...entries.entries()] : Object.entries(entries || {});
  const normalized = pairs
    .map(([p, content]) => [
      validateSafeArchivePath(p),
      Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'),
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const chunks = [];
  for (const [relPath, buf] of normalized) {
    const mode = relPath.startsWith('bin/') || relPath.endsWith('.sh') ? 0o755 : 0o644;
    chunks.push(createUstarHeader(relPath, buf.length, { mode, mtime: 0, typeflag: '0' }));
    chunks.push(buf);
    const rem = buf.length % 512;
    if (rem !== 0) {
      chunks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  // End-of-archive marker: two 512-byte zero blocks
  chunks.push(Buffer.alloc(1024, 0));

  const tarRaw = Buffer.concat(chunks);
  const gz = gzipSync(tarRaw, { level: 9 });
  // Normalize gzip header mtime (bytes 4..7) & OS byte (byte 9 = 3 Unix) for 100% deterministic SHA-256 across Windows/Linux/macOS
  if (gz.length >= 10 && gz[0] === 0x1f && gz[1] === 0x8b) {
    gz[4] = 0;
    gz[5] = 0;
    gz[6] = 0;
    gz[7] = 0;
    gz[9] = 3;
  }
  return gz;
}
