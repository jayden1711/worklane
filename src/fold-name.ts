/**
 * A name folded at least as far as any file system git or the scan may be on folds it (R1124h, R1124j): NFKC (the
 * compatibility forms: ſ, µ, ϐ, ligatures, the Kelvin sign), then upper and lower case (as APFS's case folding pairs
 * them), and final sigma as sigma. Folding further than a file system does only makes a check stricter.
 */
export const foldName = (p: string) => p.normalize('NFKC').toUpperCase().toLowerCase().replaceAll('ς', 'σ');
