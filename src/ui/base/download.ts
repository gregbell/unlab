/** Gives the browser a file to save where the person keeps downloads, as a link to it that is clicked. */
export function download(name: string, type: string, bytes: Uint8Array): void {
	const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
