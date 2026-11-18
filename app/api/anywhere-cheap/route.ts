import { NextResponse } from "next/server";
import { anywhereTrip, listAnywhereCheap, type StayBucket, type Variant } from "@/lib/anywhere-cheap";

export const dynamic = "force-dynamic";

/** "Gdziekolwiek tanio z Polski": the nightly list (filters as query params), or one stored trip (?trip=DEST&month=&stay=). */
export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  const num = (k: string) => (u.get(k) ? Number(u.get(k)) : undefined);
  const access = u.get("access") !== "0";
  if (u.get("trip")) {
    const t = await anywhereTrip(u.get("trip")!, (access ? "on" : "off") as Variant, u.get("month") ?? "", u.get("stay") ?? "any");
    return NextResponse.json({ trip: t });
  }
  const stay = u.get("stay") as StayBucket | null;
  const r = await listAnywhereCheap({
    month: u.get("month") || undefined, stay: stay && ["5-9", "10-14", "15-21"].includes(stay) ? stay : undefined,
    region: u.get("region") || undefined, maxPrice: num("max"), maxConn: num("conn"), far: u.get("far") === "1", zones: u.get("zones") === "1", access, perCountry: u.get("pc") !== null ? Number(u.get("pc")) : 2,
  });
  return NextResponse.json(r);
}
