import chalk from 'chalk'

import { debug } from './logger'
import { isDebugMode } from './mode'
import { terminalLog } from './terminal'
import { DEBUG_PATHS } from './transports'
import type { ErrorDiagnosis } from './types'

export function diagnoseError(error: any, context?: any): ErrorDiagnosis {
  const errorMessage = error instanceof Error ? error.message : String(error)
  const errorStack = error instanceof Error ? error.stack : undefined

  if (
    errorMessage.includes('aborted') ||
    errorMessage.includes('AbortController')
  ) {
    return {
      errorType: 'REQUEST_ABORTED',
      category: 'SYSTEM',
      severity: 'MEDIUM',
      description:
        'Request was aborted, often due to user cancellation or timeout',
      suggestions: [
        '检查是否按下了 ESC 键取消请求',
        '检查网络连接是否稳定',
        '验证 AbortController 状态: isActive 和 signal.aborted 应该一致',
        '查看是否有重复的请求导致冲突',
      ],
      debugSteps: [
        '使用 --debug-verbose 模式查看详细的请求流程',
        '检查 debug 日志中的 BINARY_FEEDBACK_* 事件',
        '验证 REQUEST_START 和 REQUEST_END 日志配对',
        '查看 QUERY_ABORTED 事件的触发原因',
      ],
    }
  }

  if (
    errorMessage.includes('api-key') ||
    errorMessage.includes('authentication') ||
    errorMessage.includes('401')
  ) {
    return {
      errorType: 'API_AUTHENTICATION',
      category: 'API',
      severity: 'HIGH',
      description: 'API authentication failed - invalid or missing API key',
      suggestions: [
        '运行 /login 重新设置 API 密钥',
        '检查 ~/.kode/ 配置文件中的 API 密钥',
        '验证 API 密钥是否已过期或被撤销',
        '确认使用的 provider 设置正确 (anthropic/opendev/bigdream)',
      ],
      debugSteps: [
        '检查 CONFIG_LOAD 日志中的 provider 和 API 密钥状态',
        '运行 kode doctor 检查系统健康状态',
        '查看 API_ERROR 日志了解详细错误信息',
        '使用 kode config 命令查看当前配置',
      ],
    }
  }

  if (
    errorMessage.includes('ECONNREFUSED') ||
    errorMessage.includes('ENOTFOUND') ||
    errorMessage.includes('timeout')
  ) {
    return {
      errorType: 'NETWORK_CONNECTION',
      category: 'NETWORK',
      severity: 'HIGH',
      description: 'Network connection failed - unable to reach API endpoint',
      suggestions: [
        '检查网络连接是否正常',
        '确认防火墙没有阻止相关端口',
        '检查 proxy 设置是否正确',
        '尝试切换到不同的网络环境',
        '验证 baseURL 配置是否正确',
      ],
      debugSteps: [
        '检查 API_REQUEST_START 和相关网络日志',
        '查看 LLM_REQUEST_ERROR 中的详细错误信息',
        '使用 ping 或 curl 测试 API 端点连通性',
        '检查企业网络是否需要代理设置',
      ],
    }
  }

  if (
    errorMessage.includes('permission') ||
    errorMessage.includes('EACCES') ||
    errorMessage.includes('denied')
  ) {
    return {
      errorType: 'PERMISSION_DENIED',
      category: 'PERMISSION',
      severity: 'MEDIUM',
      description: 'Permission denied - insufficient access rights',
      suggestions: [
        '检查文件和目录的读写权限',
        '确认当前用户有足够的系统权限',
        '查看是否需要管理员权限运行',
        '检查工具权限设置是否正确配置',
      ],
      debugSteps: [
        '查看 PERMISSION_* 日志了解权限检查过程',
        '检查文件系统权限: ls -la',
        '验证工具审批状态',
        '查看 TOOL_* 相关的调试日志',
      ],
    }
  }

  if (
    errorMessage.includes('substring is not a function') ||
    errorMessage.includes('content')
  ) {
    return {
      errorType: 'RESPONSE_FORMAT',
      category: 'API',
      severity: 'MEDIUM',
      description: 'LLM response format mismatch between different providers',
      suggestions: [
        '检查当前使用的 provider 是否与期望一致',
        '验证响应格式处理逻辑',
        '确认不同 provider 的响应格式差异',
        '检查是否需要更新响应解析代码',
      ],
      debugSteps: [
        '查看 LLM_CALL_DEBUG 中的响应格式',
        '检查 provider 配置和实际使用的 API',
        '对比 Anthropic 和 OpenAI 响应格式差异',
        '验证 logLLMInteraction 函数的格式处理',
      ],
    }
  }

  if (
    errorMessage.includes('too long') ||
    errorMessage.includes('context') ||
    errorMessage.includes('token')
  ) {
    return {
      errorType: 'CONTEXT_OVERFLOW',
      category: 'SYSTEM',
      severity: 'MEDIUM',
      description: 'Context window exceeded - conversation too long',
      suggestions: [
        '运行 /compact 手动压缩对话历史',
        '检查自动压缩设置是否正确配置',
        '减少单次输入的内容长度',
        '清理不必要的上下文信息',
      ],
      debugSteps: [
        '查看 AUTO_COMPACT_* 日志检查压缩触发',
        '检查 token 使用量和阈值',
        '查看 CONTEXT_COMPRESSION 相关日志',
        '验证模型的最大 token 限制',
      ],
    }
  }

  if (
    errorMessage.includes('config') ||
    (errorMessage.includes('undefined') && context?.configRelated)
  ) {
    return {
      errorType: 'CONFIGURATION',
      category: 'CONFIG',
      severity: 'MEDIUM',
      description: 'Configuration error - missing or invalid settings',
      suggestions: [
        '运行 kode config 检查配置设置',
        '删除损坏的配置文件重新初始化',
        '检查 JSON 配置文件语法是否正确',
        '验证环境变量设置',
      ],
      debugSteps: [
        '查看 CONFIG_LOAD 和 CONFIG_SAVE 日志',
        '检查配置文件路径和权限',
        '验证 JSON 格式: cat ~/.kode/config.json | jq',
        '查看配置缓存相关的调试信息',
      ],
    }
  }

  return {
    errorType: 'UNKNOWN',
    category: 'SYSTEM',
    severity: 'MEDIUM',
    description: `Unexpected error: ${errorMessage}`,
    suggestions: [
      '重新启动应用程序',
      '检查系统资源是否充足',
      '查看完整的错误日志获取更多信息',
      '如果问题持续，请报告此错误',
    ],
    debugSteps: [
      '使用 --debug-verbose 获取详细日志',
      '检查 error.log 中的完整错误信息',
      '查看系统资源使用情况',
      '收集重现步骤和环境信息',
    ],
    relatedLogs: errorStack ? [errorStack] : undefined,
  }
}

export function logErrorWithDiagnosis(
  error: any,
  context?: any,
  requestId?: string,
) {
  if (!isDebugMode()) return

  const diagnosis = diagnoseError(error, context)
  const errorMessage = error instanceof Error ? error.message : String(error)

  debug.error(
    'ERROR_OCCURRED',
    {
      error: errorMessage,
      errorType: diagnosis.errorType,
      category: diagnosis.category,
      severity: diagnosis.severity,
      context,
    },
    requestId,
  )

  terminalLog('\n' + chalk.red('🚨 ERROR DIAGNOSIS'))
  terminalLog(chalk.gray('━'.repeat(60)))

  terminalLog(chalk.red(`❌ ${diagnosis.errorType}`))
  terminalLog(
    chalk.dim(
      `Category: ${diagnosis.category} | Severity: ${diagnosis.severity}`,
    ),
  )
  terminalLog(`\n${diagnosis.description}`)

  terminalLog(chalk.yellow('\n💡 Recovery Suggestions:'))
  diagnosis.suggestions.forEach((suggestion, index) => {
    terminalLog(`   ${index + 1}. ${suggestion}`)
  })

  terminalLog(chalk.cyan('\n🔍 Debug Steps:'))
  diagnosis.debugSteps.forEach((step, index) => {
    terminalLog(`   ${index + 1}. ${step}`)
  })

  if (diagnosis.relatedLogs && diagnosis.relatedLogs.length > 0) {
    terminalLog(chalk.magenta('\n📋 Related Information:'))
    diagnosis.relatedLogs.forEach(log => {
      const truncatedLog =
        log.length > 200 ? log.substring(0, 200) + '...' : log
      terminalLog(chalk.dim(`   ${truncatedLog}`))
    })
  }

  const debugPath = DEBUG_PATHS.base()
  terminalLog(chalk.gray(`\n📁 Complete logs: ${debugPath}`))
  terminalLog(chalk.gray('━'.repeat(60)))
}
