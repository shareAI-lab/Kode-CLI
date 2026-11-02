// Do not retain the original error: JSON parser messages can contain settings
// values (including credentials). Hosts can safely display this diagnostic.
export class SettingsFileError extends Error {
  constructor(
    readonly filePath: string,
    reason: string,
  ) {
    super(
      `Cannot load settings from ${JSON.stringify(filePath)}: ${reason}. Fix the settings file before continuing.`,
    )
    this.name = 'SettingsFileError'
  }
}

export class ConfigParseError extends Error {
  filePath: string
  defaultConfig: unknown

  constructor(message: string, filePath: string, defaultConfig: unknown) {
    super(message)
    this.name = 'ConfigParseError'
    this.filePath = filePath
    this.defaultConfig = defaultConfig
  }
}
