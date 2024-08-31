import { v4 as uuidv4 } from 'uuid';

export const newUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
    // crypto.randomUUID is available in most of the modern browsers and node,
    // but is not available in "insecure" contexts, e.g. not https, not localhost
    // so we fallback to uuidv4 in those cases, which is less secure, but works
    // just fine.
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    } else {
        return uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
    }
}
