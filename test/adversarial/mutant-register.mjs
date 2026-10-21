// Loaded by NODE_OPTIONS in test/adversarial/run-mutants.mjs's children: registers the mutant named in the
// environment, or nothing when none is named.
import { register } from 'node:module';

const id = process.env.ADVERSARIAL_MUTANT;
if (id) register(new URL('./mutant-hooks.mjs', import.meta.url), { data: { id } });
