import { v4 as uuidv4 } from 'uuid';

export const newUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    } else {
        return uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
    }
}