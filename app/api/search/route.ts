import { runSearch } from "@/lib/engine";
import type { SearchParams } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Server-Sent Events: the client watches the branch and bound as it runs.
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("p");
  let params: SearchParams;
  try {
    params = JSON.parse(Buffer.from(raw ?? "", "base64url").toString("utf8"));
    if (!params.origin?.length || !params.dest?.length) throw new Error("missing airports");
  } catch (e) {
    return new Response(`bad params: ${(e as Error).message}`, { status: 400 });
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { open = false; }
      };
      const ping = setInterval(() => send("ping", Date.now()), 15000);
      try {
        const result = await runSearch(params, send, req.signal);
        send("done", result);
      } catch (e) {
        send("fail", { message: (e as Error).message });
      } finally {
        clearInterval(ping);
        open = false;
        try { controller.close(); } catch {}
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
