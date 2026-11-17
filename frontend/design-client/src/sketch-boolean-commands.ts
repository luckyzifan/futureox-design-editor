export const sketchBooleanCommands = {
  'boolean-add': { operation: 'compoundEvenodd', letter: 'A' },
  'boolean-union': { operation: 'union', letter: 'U' },
  'boolean-subtract': { operation: 'subtract', letter: 'S' },
  'boolean-intersect': { operation: 'intersect', letter: 'I' },
  'boolean-exclude': { operation: 'exclude', letter: 'X' },
} as const

export type SketchBooleanCommand = keyof typeof sketchBooleanCommands
export const sketchBooleanCommandIds = Object.keys(sketchBooleanCommands) as SketchBooleanCommand[]

export function isSketchBooleanCommand(command: string): command is SketchBooleanCommand {
  return Object.hasOwn(sketchBooleanCommands, command)
}
