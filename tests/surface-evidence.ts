import assert from 'node:assert/strict'
import { canvasCoordinateMapping, matrixFrom, transformPoint } from '../src/surface-evidence.ts'

const matrix = matrixFrom({ a: 2, b: 0, c: 0, d: 3, e: 10, f: 20 })
assert.deepEqual(matrix, { a: 2, b: 0, c: 0, d: 3, e: 10, f: 20 })
assert.deepEqual(transformPoint(matrix!, { x: 4, y: 5 }), { x: 18, y: 35 })

const mapping = canvasCoordinateMapping({
  rect: { x: 100, y: 50, width: 200, height: 100 },
  backingWidth: 400,
  backingHeight: 250,
  viewportPoint: { x: 150, y: 75 },
})
assert.deepEqual(mapping.canvasCssPoint, { x: 50, y: 25 })
assert.deepEqual(mapping.canvasBackingPoint, { x: 100, y: 62.5 })
assert.equal(mapping.inBounds, true)
assert.equal(canvasCoordinateMapping({ rect: { x: 0, y: 0, width: 100, height: 100 }, backingWidth: 200, backingHeight: 200, viewportPoint: { x: 100, y: 20 } }).inBounds, false)

process.stdout.write(`${JSON.stringify({ ok: true, matrixPrecision: true, svgPointTransform: true, canvasCoordinateMapping: true }, null, 2)}\n`)
