import { currentCoverage } from "../lib/map";
currentCoverage().then((c) => { console.log(JSON.stringify(c)); process.exit(0); });
