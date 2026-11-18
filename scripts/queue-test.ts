import { parseQuery } from "../lib/parse";
import { startLive } from "../lib/live";
(async () => {
  const { params } = (await parseQuery(process.argv[2])) as any;
  if (process.argv[3]) params.depth = process.argv[3];
  console.log(await startLive(params));
  process.exit(0);
})();
