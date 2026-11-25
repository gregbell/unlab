// The lab image that is published and pinned. After scripts/build-lab-image.ts
// makes another, publish it as a release of its own and change this to it.

export const LAB_IMAGE = {
	name: "lab",
	file: "lab.erofs",
	size: 16297984,
	sha256: "2a2f31d43734a20e8e58ffffcb71efde402682402cadeabce34e2bd72b07f53c",
	image: "lab-1",
	release: "https://github.com/gregbell/unlab/releases/download/lab-image-1/",
	/** What unkernel's own images were at when it was built from one. It must be built again when they move on. */
	abi: 4,
};
