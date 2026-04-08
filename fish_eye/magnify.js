import fisheye from './index.js';

const initFisheye = () => {
  const img = document.querySelector('img');
  if (!img) return;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  canvas.style.maxWidth = '100%';
  canvas.style.height = 'auto';
  canvas.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.1)';
  canvas.style.cursor = 'crosshair';

  img.parentNode.insertBefore(canvas, img);
  img.style.display = 'none';

  let width, height;
  let baseDataBuf = null; // Uint32Array for raw original pixel speeds
  let activeDataBuf = null;
  let activeImageData = null;

  const setup = () => {
    width = img.naturalWidth || img.width || 800;
    height = img.naturalHeight || img.height || 600;

    canvas.width = width;
    canvas.height = height;

    // Draw the image and grab its pure byte array
    ctx.drawImage(img, 0, 0, width, height);
    const id = ctx.getImageData(0, 0, width, height);

    // We use a 32-bit view to move whole pixels (R,G,B,A) at once which is 4x faster
    baseDataBuf = new Uint32Array(id.data.buffer).slice(0); // Deep copy
    activeImageData = new ImageData(new Uint8ClampedArray(id.data), width, height);
    activeDataBuf = new Uint32Array(activeImageData.data.buffer);

    drawNormal();
  };

  if (img.complete && img.naturalWidth > 0) {
    setup();
  } else {
    img.addEventListener('load', setup);
  }

  function drawNormal() {
    activeDataBuf.set(baseDataBuf);
    ctx.putImageData(activeImageData, 0, 0);
  }

  const distortion = 20;
  const baseRadius = 300;

  // Cache variables to prevent garbage collection hits
  let isMouseOver = false;

  canvas.addEventListener('mousemove', (e) => {
    if (!baseDataBuf) return;
    isMouseOver = true;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;

    const scaleX = width / rect.width;
    const scaleY = height / rect.height;

    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    const radius = baseRadius * Math.max(scaleX, scaleY);

    // Instead of drawing geometric chunks, we use an inverse mapping lookup table (LUT).
    // The fisheye mathematically pulls pixels outwardly. To render every destination pixel,
    // we must find the source pixel that lands there!

    const e_const = Math.exp(distortion);
    const k0 = e_const / (e_const - 1) * radius;
    const k1 = distortion / radius;

    // We create a fast lookup up to the maximum possible expansion distance
    const MAX_LUT = Math.ceil(radius * 12);
    const invLUT = new Float32Array(MAX_LUT);

    let maxDestDist = 0;

    // Build the mapping array by walking outward from the center
    for (let d = 0; d < radius; d += 0.05) {
      let dest_d;
      if (d === 0) {
        dest_d = 0;
      } else {
        const k = k0 * (1 - Math.exp(-d * k1)) / d * 0.75 + 0.25;
        dest_d = d * k;
      }
      if (dest_d >= 0 && dest_d < MAX_LUT) {
        const intDest = Math.floor(dest_d);
        if (invLUT[intDest] === 0) {
          invLUT[intDest] = d;
        }
        if (dest_d > maxDestDist) maxDestDist = dest_d;
      }
    }

    // Simple interpolation fill for any micro gaps in the LUT
    let last = 0;
    for (let i = 0; i < maxDestDist; i++) {
      if (invLUT[i] === 0 && i !== 0) invLUT[i] = last;
      else last = invLUT[i];
    }

    // Reset our canvas pixel buffer to the pristine original state
    activeDataBuf.set(baseDataBuf);

    // Instead of the whole screen, we only loop over the exact box that distorts
    const maxShiftBoxSize = Math.ceil(maxDestDist);
    const startX = Math.max(0, Math.floor(mouseX - maxShiftBoxSize));
    const endX = Math.min(width - 1, Math.ceil(mouseX + maxShiftBoxSize));
    const startY = Math.max(0, Math.floor(mouseY - maxShiftBoxSize));
    const endY = Math.min(height - 1, Math.ceil(mouseY + maxShiftBoxSize));

    const cx = mouseX;
    const cy = mouseY;

    for (let y = startY; y <= endY; y++) {
      const idxRow = y * width;
      for (let x = startX; x <= endX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // If this pixel falls inside the expanded fisheye lens range
        if (dist <= maxDestDist && dist < MAX_LUT) {
          const srcDist = invLUT[Math.floor(dist)];

          // We scale the angle vector back to the source distance
          const ratio = dist === 0 ? 0 : srcDist / dist;
          let srcX = cx + dx * ratio;
          let srcY = cy + dy * ratio;

          // Lock boundary limits to avoid index errors
          if (srcX < 0) srcX = 0;
          if (srcX >= width) srcX = width - 1;
          if (srcY < 0) srcY = 0;
          if (srcY >= height) srcY = height - 1;

          // Pull that strict source pixel logic and assign it exactly to our screen
          const srcIdx = Math.floor(srcY) * width + Math.floor(srcX);
          activeDataBuf[idxRow + x] = baseDataBuf[srcIdx];
        }
      }
    }

    // Push the raw bytes straight to GPU!
    ctx.putImageData(activeImageData, 0, 0);
  });

  canvas.addEventListener('mouseleave', () => {
    isMouseOver = false;
    drawNormal();
  });
};

document.addEventListener('DOMContentLoaded', initFisheye);
