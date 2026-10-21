// Loaded by NODE_OPTIONS in test/adversarial/run-mutants.mjs's children: registers the mutant named in the
// environment (from the list the environment names, or test/adversarial/mutants.json), or nothing when none is named.
import { register } from 'node:module';

const id = process.env.ADVERSARIAL_MUTANT;
const list = process.env.ADVERSARIAL_MUTANT_LIST;
if (id) register(new URL('./mutant-hooks.mjs', import.meta.url), { data: { id, ...(list ? { list } : {}) } });
