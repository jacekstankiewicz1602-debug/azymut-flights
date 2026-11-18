// One-off Google baseline: npx tsx scripts/baseline.ts "POZ,BER,WAW" "LIM,CUZ,AQP" 2027-02-22 2027-03-10
import { googleRoundTrip } from "../lib/sources/google";
import { Meter } from "../lib/sources/http";
async function main() {
  const [from, to, out, ret] = process.argv.slice(2);
  const r = await googleRoundTrip(from.split(","), to.split(","), out, ret, new Meter());
  console.log(r ? `${r.price} zł (${r.outbound.carriers}, ${r.outbound.depLocal})` : "no result");
  process.exit(0);
}
main();
