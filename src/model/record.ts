/** A copy without `key`, or the same record when the key is not there. */
export function without<K extends string, V>(
	record: Readonly<Partial<Record<K, V>>>,
	key: K,
): Readonly<Partial<Record<K, V>>> {
	if (record[key] === undefined) return record;
	const next = { ...record };
	delete next[key];
	return next;
}
