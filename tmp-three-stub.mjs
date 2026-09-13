export class CanvasTexture {
  constructor(image) { this.image = image; this.isCanvasTexture = true; }
  dispose() { this.disposed = true; }
}
export const NearestFilter = 1003;
export const LinearFilter = 1006;
export const LinearMipMapLinearFilter = 1008;
export const SRGBColorSpace = 'srgb';
