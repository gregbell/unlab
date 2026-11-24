/** Machine n's, whatever it is called: a name can be another machine's later. */
export const diskName = (n: number): string => `unlab-node${n}`;

export function deleteMachineDisk(n: number): void {
	const request = indexedDB.deleteDatabase(`kwdisk:${diskName(n)}-v1`);
	request.onerror = () => console.error(`Could not delete the disk ${diskName(n)}`, request.error);
}
