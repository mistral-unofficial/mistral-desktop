export type SettingsSection = 'account' | 'connectors' | 'general'

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'account', label: 'Account' },
  { id: 'connectors', label: 'Connectors' }
]
