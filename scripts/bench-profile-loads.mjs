const t = label => {
  const start = performance.now()
  return () =>
    console.log(`${label}: ${Math.round(performance.now() - start)}ms`)
}

process.env.NODE_ENV = 'test'
process.env.KODE_ENTRYPOINT = 'cli'
process.env.KODE_STARTUP_PROFILE = '1'
process.env.KODE_STARTUP_PROFILE_MEMORY = '1'

const total = t('total')

let done = t('import @kode/agent (startAgentWatcher)')
await import('@kode/agent')
done()

let done2 = t('import #core/utils/autoUpdater')
await import('#core/utils/autoUpdater')
done2()

let done3 = t('import #cli-services/skillMarketplace')
await import('#cli-services/skillMarketplace')
done3()

let done4 = t(
  'session utils: kodeAgentSessionLoad/Resume/uuid/sessionId/ForkInfo',
)
await Promise.all([
  import('#protocol/utils/kodeAgentSessionLoad'),
  import('#protocol/utils/kodeAgentSessionResume'),
  import('#core/utils/uuid'),
  import('#core/utils/sessionId'),
  import('#protocol/utils/kodeAgentSessionId'),
  import('#protocol/utils/kodeAgentSessionForkInfo'),
])
done4()

let done5 = t('import #ui-ink/screens/REPL + ink')
await Promise.all([import('ink'), import('#ui-ink/screens/REPL')])
done5()

let done6 = t('import #core/utils/log + #core/query types')
await import('#core/utils/log')
done6()

total()
process.exit(0)
