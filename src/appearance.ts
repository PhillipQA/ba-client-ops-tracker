export type InterfaceMode = 'dark' | 'light' | 'gray'

export const INTERFACE_MODES: { id: InterfaceMode; name: string; description: string }[] = [
  { id: 'dark', name: 'Dark', description: 'Deep charcoal surfaces with bright text.' },
  { id: 'light', name: 'Light', description: 'Clean white surfaces with dark text.' },
  { id: 'gray', name: 'Gray', description: 'Soft gray surfaces with dark text.' },
]

// A missing preference keeps the user's original background-theme appearance.
export function normalizeInterfaceMode(value: unknown): InterfaceMode | null {
  return value === 'dark' || value === 'light' || value === 'gray' ? value : null
}
