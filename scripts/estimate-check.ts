// The time estimate for a query: npx tsx scripts/estimate-check.ts "<query>"
import { parseQuery } from "../lib/parse";
import { estimate } from "../lib/estimate";
(async () => {
  const { params } = await parseQuery(process.argv[2]);
  console.log(process.argv[2], JSON.stringify(await estimate(params)));
  process.exit(0);
})();
