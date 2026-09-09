export type LosslessJsonScalar = null | boolean | number | string
export type LosslessJsonValue = LosslessJsonScalar | LosslessJsonValue[] | { [key: string]: LosslessJsonValue }

type VisitTask = {
  value: unknown
  path: string
  leaving?: boolean
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

export function findLosslessJsonViolation(value: unknown, rootPath = 'data'): string | undefined {
  // 这里不能使用 JSON.stringify 往返检查，因为 stringify 会删除 undefined、把非有限数改成 null，
  // 还会执行对象自定义的 toJSON，从而把真实工具输出缺陷伪装成合法结果。该遍历顺序与 DSH
  // 的 lossless JSON 边界一致，只返回字段路径和缺陷类别，不读取或输出字段的实际敏感内容。
  const ancestors = new Set<object>()
  const tasks: VisitTask[] = [{ value, path: rootPath }]

  while (tasks.length > 0) {
    const task = tasks.pop()
    if (task === undefined) break
    if (task.leaving === true) {
      ancestors.delete(task.value as object)
      continue
    }

    if (task.value === null || typeof task.value === 'string' || typeof task.value === 'boolean') continue
    if (typeof task.value === 'number') {
      if (!Number.isFinite(task.value)) return `${task.path} contains a non-finite number`
      if (Object.is(task.value, -0)) return `${task.path} contains -0`
      continue
    }
    if (typeof task.value === 'undefined') return `${task.path} contains undefined`
    if (typeof task.value === 'symbol') return `${task.path} contains a Symbol`
    if (typeof task.value !== 'object') return `${task.path} contains a non-JSON ${typeof task.value}`
    if (ancestors.has(task.value)) return `${task.path} contains a circular reference`

    if (Array.isArray(task.value)) {
      const ownKeys = Reflect.ownKeys(task.value)
      if (Object.getPrototypeOf(task.value) !== Array.prototype) return `${task.path} is not a plain Array`
      if (ownKeys.length !== task.value.length + 1) return `${task.path} is sparse or has extra own properties`
      ancestors.add(task.value)
      tasks.push({ value: task.value, path: task.path, leaving: true })
      for (let index = task.value.length - 1; index >= 0; index -= 1) {
        if (!Object.hasOwn(task.value, index)) return `${task.path}[${index}] is missing from a sparse Array`
        tasks.push({ value: task.value[index], path: `${task.path}[${index}]` })
      }
      continue
    }

    if (!isPlainRecord(task.value)) return `${task.path} is not a plain object`
    const ownKeys = Reflect.ownKeys(task.value)
    if (ownKeys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(task.value, key))) {
      return `${task.path} contains a Symbol or non-enumerable own property`
    }
    ancestors.add(task.value)
    tasks.push({ value: task.value, path: task.path, leaving: true })
    const entries = Object.entries(task.value)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry !== undefined) tasks.push({ value: entry[1], path: `${task.path}.${entry[0]}` })
    }
  }

  return undefined
}

export function assertLosslessJson(value: unknown, rootPath = 'data'): asserts value is LosslessJsonValue {
  const violation = findLosslessJsonViolation(value, rootPath)
  if (violation !== undefined) throw new TypeError(`browser diagnostic output is not lossless JSON: ${violation}`)
}
