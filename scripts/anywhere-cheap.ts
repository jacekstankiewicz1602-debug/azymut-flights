// Run the "gdziekolwiek tanio z Polski" job now (same code as the worker's nightly run; resumes an unfinished run).
//   npx tsx scripts/anywhere-cheap.ts [kiwiLimit=200] [composeLimit=40] [composeSeconds=120]
import { runAnywhereCheap } from "../lib/anywhere-cheap";
(async () => {
  const [k, c, sec] = process.argv.slice(2).map(Number);
  await runAnywhereCheap(async () => false, (s) => console.log(new Date().toISOString().slice(11, 19), s),
    { kiwiLimit: k || 200, composeLimit: c || 40, composeSeconds: sec || 120 });
  process.exit(0);
})();
