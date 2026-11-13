/** A value as an array: itself when it is one, else empty. For reading stored data whose lists may be missing. */
export const asList = (value: unknown): any[] => (Array.isArray(value) ? value : [])
