// three ships no types and the repo has no @types/three; only what title-typeface.test.ts touches.
declare module "three/addons/loaders/FontLoader.js" {
  export class Font {
    constructor(data: unknown);
    generateShapes(text: string, size: number): { holes: unknown[] }[];
  }
}

declare module "three/addons/geometries/TextGeometry.js" {
  interface Box3Like {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  }
  export class TextGeometry {
    constructor(
      text: string,
      parameters: { font: unknown; size: number; depth: number; curveSegments: number },
    );
    boundingBox: Box3Like | null;
    computeBoundingBox(): void;
  }
}
