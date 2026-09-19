export type AppTheme = 'default' | 'dark-geek' | 'blue-sky' | 'green-grass' | 'busy-city' | 'calm-mountain'

export type AppThemeOption = {
  id: AppTheme
  name: string
  description: string
  image?: string
  palette: string
}

export const THEME_OPTIONS: AppThemeOption[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Current Client Ops dark workspace.',
    palette: 'Charcoal · slate · cool blue',
  },
  {
    id: 'dark-geek',
    name: 'Dark Geek Mode',
    description: 'Deep-tech workspace with cyber blue and violet accents.',
    image: '/themes/dark-geek.webp',
    palette: 'Midnight · cyan · violet',
  },
  {
    id: 'blue-sky',
    name: 'Light Blue Sky Beach Mode',
    description: 'Bright tropical coast with airy glass-like panels.',
    image: '/themes/blue-sky.webp',
    palette: 'Sky blue · turquoise · sand',
  },
  {
    id: 'green-grass',
    name: 'Green Grass with Insects',
    description: 'Fresh meadow tones with warm natural highlights.',
    image: '/themes/green-grass.webp',
    palette: 'Leaf green · moss · sunlight',
  },
  {
    id: 'busy-city',
    name: 'Busy City Streets',
    description: 'Urban dusk with steel, amber, and traffic-light energy.',
    image: '/themes/busy-city.webp',
    palette: 'Steel · amber · red',
  },
  {
    id: 'calm-mountain',
    name: 'Calm Mountain — Bahay Kubo',
    description: 'A peaceful bahay kubo overlooking the sea and mountains.',
    image: '/themes/calm-mountain.webp',
    palette: 'Ocean blue · leaf green · warm wood',
  },
]

export const THEME_IDS = new Set<AppTheme>(THEME_OPTIONS.map((theme) => theme.id))

export function normalizeAppTheme(value: unknown): AppTheme {
  return typeof value === 'string' && THEME_IDS.has(value as AppTheme) ? value as AppTheme : 'default'
}

export function normalizeClientThemes(value: unknown): Record<string, AppTheme> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, theme]) => typeof theme === 'string' && THEME_IDS.has(theme as AppTheme)))
}
export function themeForContext(user: { theme?: AppTheme; clientThemes?: Record<string, AppTheme> }, clientId?: string | null): AppTheme {
  const overrides = normalizeClientThemes(user.clientThemes)
  return normalizeAppTheme(clientId && Object.prototype.hasOwnProperty.call(overrides, clientId) ? overrides[clientId] : user.theme)
}
