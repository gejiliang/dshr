/**
 * 凭证对话框：已知 credential ref 的列表 + 掩码录入 + 带确认的删除。
 *
 * 设计判据（2026-08-18 与 GG 对齐，推翻「终端不给输密钥」的旧判断）：
 * - `dsh-credentials-local` 是 dsh 管理的**专用凭证存储**（跨进程写锁、只 patch 自己那个键、
 *   永不物化进环境），上游注释明说预期客户端提供录入入口（"a key stored through the
 *   Models page"）。对 SSH 过来的人，替代方案是登到宿主机改文件——各方面都更差。
 * - 正确做法不是「不给输」，是**带掩码输入**（ssh / sudo / gh auth 同款）。
 *
 * 硬纪律：
 * - 值只在 `credentials.set` 的载荷里越线一次；**不进日志 / 通知 / 错误消息 / 测试夹具**。
 * - 没有读回——界面上永远只有「configured（via `<source>`）/ not configured」。
 * - `writable: false` 的 ref 只读展示，点了给可读理由（上游会以 `credential-rejected` 拒，
 *   但客户端先拦，理由更清楚）。
 * - `unset` 是破坏性动作，要一步确认。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import type { CredentialRefState } from '@dshr/state'
import { credentialOptions } from '../dialog-data.js'
import { DialogSelect } from './DialogSelect.js'
import { DialogPrompt } from './DialogPrompt.js'
import { theme } from '../theme.js'

export interface CredentialsDialogProps {
  /** `DshrState.describeCredentials` 的透传（**调用方保证引用稳定**——进 useEffect 依赖）。 */
  readonly load: () => Promise<readonly CredentialRefState[]>
  /** `DshrState.setCredential` 的透传。value 来自掩码输入，本组件不留副本。 */
  readonly onSet: (ref: string, value: string) => Promise<void>
  /** `DshrState.unsetCredential` 的透传。 */
  readonly onUnset: (ref: string) => Promise<void>
  readonly onClose: () => void
  readonly maxHeight?: number
}

type Screen =
  | { readonly kind: 'list' }
  | { readonly kind: 'actions'; readonly ref: CredentialRefState }
  | { readonly kind: 'set'; readonly ref: CredentialRefState }
  | { readonly kind: 'confirm-unset'; readonly ref: CredentialRefState }

type ListData =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly credentials: readonly CredentialRefState[] }

interface Receipt {
  readonly tone: 'ok' | 'error'
  readonly text: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function CredentialsDialog({ load, onSet, onUnset, onClose, maxHeight }: CredentialsDialogProps): ReactElement {
  const [data, setData] = useState<ListData>({ status: 'loading' })
  const [screen, setScreenState] = useState<Screen>({ kind: 'list' })
  const screenRef = useRef(screen)
  const setScreen = (next: Screen): void => {
    screenRef.current = next
    setScreenState(next)
  }
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const inFlight = useRef(false)
  // 重取令牌：set/unset 成功后刷新列表，latest-wins。
  const [round, setRound] = useState(0)

  useEffect(() => {
    let alive = true
    setData({ status: 'loading' })
    load().then(
      (credentials) => {
        if (alive) setData({ status: 'ready', credentials })
      },
      (error: unknown) => {
        if (alive) setData({ status: 'error', message: errorText(error) })
      },
    )
    return () => {
      alive = false
    }
  }, [load, round])

  // loading / error 态的键这里自己收（ready 态全归 DialogSelect）。
  useInput((_input, key) => {
    if (screenRef.current.kind !== 'list') return
    if (data.status === 'ready') return
    if (key.escape || key.return) onClose()
  })

  /** 一次写 + 回执（⚠️ 回执文本永远不带值）+ 刷新列表。 */
  const runWrite = async (
    write: () => Promise<void>,
    doneText: string,
  ): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      await write()
      setReceipt({ tone: 'ok', text: doneText })
      setRound((n) => n + 1)
    } catch (error) {
      setReceipt({ tone: 'error', text: errorText(error) })
    } finally {
      inFlight.current = false
    }
    setScreen({ kind: 'list' })
  }

  const onRefSelect = (refName: string): void => {
    if (data.status !== 'ready') return
    const credential = data.credentials.find((candidate) => candidate.ref === refName)
    if (credential === undefined) return
    setReceipt(null)
    if (!credential.writable) {
      setReceipt({
        tone: 'error',
        text: `${credential.ref} is read-only here — a layer the host cannot write (e.g. the live environment) supplies it`,
      })
      return
    }
    setScreen({ kind: 'actions', ref: credential })
  }

  let body: ReactElement
  if (screen.kind === 'set') {
    body = (
      // key 钉住屏幕身份：对话框内部高亮/输入态不跨屏继承（同 SettingsEditor）。
      <DialogPrompt
        key={`set:${screen.ref.ref}`}
        title={`Set ${screen.ref.ref}`}
        mask
        placeholder="value is masked and never shown again"
        onSubmit={(value) => {
          // ⚠️ value 从这里直接进 onSet，不进任何状态 / 日志 / 回执。
          void runWrite(() => onSet(screen.ref.ref, value), `${screen.ref.ref} updated`)
        }}
        onCancel={() => setScreen({ kind: 'list' })}
      />
    )
  } else if (screen.kind === 'confirm-unset') {
    body = (
      <DialogSelect
        key={`confirm-unset:${screen.ref.ref}`}
        title={`Unset ${screen.ref.ref}?`}
        options={[
          { title: 'Cancel', value: 'cancel' },
          {
            title: `Unset ${screen.ref.ref}`,
            label: 'removes the stored value',
            tone: 'error',
            value: 'unset',
          },
        ]}
        onSelect={(choice) => {
          if (choice === 'unset') {
            void runWrite(() => onUnset(screen.ref.ref), `${screen.ref.ref} unset`)
          } else {
            setScreen({ kind: 'list' })
          }
        }}
        onCancel={() => setScreen({ kind: 'list' })}
      />
    )
  } else if (screen.kind === 'actions') {
    const credential = screen.ref
    body = (
      <DialogSelect
        key={`actions:${credential.ref}`}
        title={credential.ref}
        options={[
          {
            title: 'Set value…',
            label: 'masked input, stored by the host',
            value: 'set',
          },
          ...(credential.configured
            ? [{ title: 'Unset…', label: 'requires confirmation', tone: 'error' as const, value: 'unset' }]
            : []),
        ]}
        onSelect={(choice) => {
          if (choice === 'set') setScreen({ kind: 'set', ref: credential })
          else if (choice === 'unset') setScreen({ kind: 'confirm-unset', ref: credential })
        }}
        onCancel={() => setScreen({ kind: 'list' })}
      />
    )
  } else if (data.status === 'ready') {
    body = (
      <DialogSelect
        key="list"
        title="Credentials"
        options={credentialOptions(data.credentials)}
        {...(maxHeight !== undefined ? { maxHeight } : {})}
        onSelect={onRefSelect}
        onCancel={onClose}
      />
    )
  } else {
    body = (
      <Box flexDirection="column">
        {/* 标题行与 DialogSelect 同位 */}
        <Box paddingLeft={4} paddingRight={4} justifyContent="space-between">
          <Text color={theme.text} bold>
            Credentials
          </Text>
          <Text color={theme.textMuted}>esc</Text>
        </Box>
        <Box height={1} flexShrink={0} />
        <Box paddingLeft={4} paddingRight={4}>
          {data.status === 'loading' ? (
            <Text color={theme.textMuted}>Loading…</Text>
          ) : (
            <Text color={theme.error}>{data.message}</Text>
          )}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {receipt !== null ? (
        <>
          <Box paddingLeft={4} paddingRight={4}>
            <Text color={receipt.tone === 'error' ? theme.error : theme.info}>{receipt.text}</Text>
          </Box>
          <Box height={1} flexShrink={0} />
        </>
      ) : null}
      {body}
      {screen.kind === 'list' && data.status === 'ready' ? (
        <>
          <Box height={1} flexShrink={0} />
          <Box paddingLeft={4} paddingRight={4}>
            <Text color={theme.textMuted}>values never leave the host · enter to set (masked) or unset</Text>
          </Box>
        </>
      ) : null}
    </Box>
  )
}
