import path from "node:path";
import { syntheticInputs } from "./report.ts";

const inputs = await syntheticInputs(path.resolve(import.meta.dirname, "../../../target/leader-cases-142/fixture"));
process.stdout.write(JSON.stringify({ bundle: inputs.bundlePath, manuscript: inputs.manuscriptPath }) + "\n");
