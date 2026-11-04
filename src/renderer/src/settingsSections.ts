export type SettingsSection = 'account' | 'connectors' | 'general'

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'general', label: 'General' }
]
