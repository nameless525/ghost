// Tileable film grain for the CSS dither layer (hides 8-bit banding in the gradients). Made at
// startup, so it stays out of Pixi's module graph and uses a CPU-backed canvas: toDataURL on a
// GPU canvas is a synchronous read back from the GPU process.
export function makeGrainDataUrl(size = 160): string {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d', { willReadFrequently: true })!
  const img = g.createImageData(size, size)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = Math.floor(Math.random() * 28)
  }
  g.putImageData(img, 0, 0)
  return c.toDataURL('image/png')
}
