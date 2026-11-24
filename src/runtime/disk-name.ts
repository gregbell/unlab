export const diskName = (node: string): string => `unlab-${node}`;

export function deleteMachineDisk(node: string): void {
	const request = indexedDB.deleteDatabase(`kwdisk:${diskName(node)}-v1`);
	request.onerror = () => console.error(`Could not delete the disk for ${node}`, request.error);
}
