import { Deflate, Inflate, Zlib, Unzlib, Gzip, Gunzip } from "fflate";

type Codec = { push(chunk: Uint8Array, final?: boolean): void };
type StreamConstructor = typeof CompressionStream;
export interface CompressionHost {
  CompressionStream?: StreamConstructor;
  DecompressionStream?: typeof DecompressionStream;
}

// A TransformStream preserves pipeThrough/backpressure/error semantics. fflate
// emits raw RFC1951 bytes for deflate-raw and RFC1950/1952 for deflate/gzip.
function compatible(Native: StreamConstructor | undefined, decode: boolean) {
  return class CompatibleCompressionStream {
    readonly readable!: ReadableStream<Uint8Array>;
    readonly writable!: WritableStream<BufferSource>;
    constructor(format: CompressionFormat) {
      if (!["deflate-raw", "deflate", "gzip"].includes(format))
        throw new TypeError("Unsupported compression format: " + format);
      if (Native) {
        try {
          return new Native(format);
        } catch {
          // Old WebViews may expose the constructors without raw support.
        }
      }
      let codec: Codec;
      const stream = new TransformStream<BufferSource, Uint8Array>({
        start(controller) {
          const emit = (bytes: Uint8Array) => {
            if (bytes.length) controller.enqueue(bytes.slice());
          };
          codec =
            format === "deflate-raw"
              ? decode
                ? new Inflate(emit)
                : new Deflate(emit)
              : format === "deflate"
                ? decode
                  ? new Unzlib(emit)
                  : new Zlib(emit)
                : decode
                  ? new Gunzip(emit)
                  : new Gzip(emit);
        },
        transform(chunk) {
          if (!(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk))
            throw new TypeError("Compression input must be a BufferSource");
          const bytes =
            chunk instanceof ArrayBuffer
              ? new Uint8Array(chunk)
              : new Uint8Array(
                  chunk.buffer,
                  chunk.byteOffset,
                  chunk.byteLength,
                );
          codec.push(bytes, false);
        },
        flush() {
          codec.push(new Uint8Array(0), true);
        },
      });
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  } as unknown as StreamConstructor;
}

export function installCompressionStreams(host: CompressionHost = globalThis) {
  for (const name of ["CompressionStream", "DecompressionStream"] as const) {
    const Native = host[name];
    try {
      if (Native) {
        new Native("deflate-raw");
        continue;
      }
    } catch {
      /* Install only when the needed format is unavailable. */
    }
    Object.defineProperty(host, name, {
      configurable: true,
      writable: true,
      value: compatible(Native, name === "DecompressionStream"),
    });
  }
}
