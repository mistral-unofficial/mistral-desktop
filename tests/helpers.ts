/** Build a streaming fetch Response from raw SSE text pieces (pieces may split mid-line). */
export function sseResponse(pieces: string[], init: ResponseInit = { status: 200 }): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pieces) c.enqueue(enc.encode(p))
      c.close()
    }
  })
  return new Response(stream, init)
}
export const data = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`
export const chunk = (delta: object, finish: string | null = null, extra: object = {}): string =>
  data({ choices: [{ index: 0, delta, finish_reason: finish }], ...extra })
