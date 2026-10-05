# willLag ⚡ — otimizador local de latência para jogos (Windows)

Aplicativo desktop (Electron + React) que reduz **ping, jitter e perda de
pacotes** em jogos online atacando as causas do lado do cliente: pilha TCP/IP,
economia de energia de adaptadores Wi-Fi USB, resolução DNS e MTU do caminho.

Tudo é **local** (nada de servidor, proxy ou assinatura) e tudo é **reversível**:
cada alteração é detectada antes, gravada em backup, aplicada, conferida depois e
pode ser desfeita individualmente, por preset ou de uma vez.

> **Estado atual:** o processo principal (Windows/PowerShell/registro/netsh) está
> completo e testado; a interface roda em Electron e também no navegador, em
> *modo demonstração*, com o mesmo catálogo real de ajustes.

---

## O problema que ele resolve

| Sintoma | Causa típica | O que o willLag faz |
| --- | --- | --- |
| Ping sobe 50–200 ms **a cada 30–60 s** | varredura de redes Wi-Fi em segundo plano (rádio sai do canal) + dongle USB entrando em suspensão seletiva | pausa o `autoconfig` durante o jogo, desativa USB Selective Suspend e a energia do adaptador |
| Delay de tiro / movimento "preso" | Nagle + delayed ACK segurando pacotes de 40–120 bytes; RSC agregando pacotes recebidos | `TcpAckFrequency=1` / `TCPNoDelay=1` por interface, `rsc=disabled` |
| Micro-stall com Discord/voice aberto | MMCSS limitando tráfego não-multimídia a 10 pacotes/ms e reservando 20% da CPU | `NetworkThrottlingIndex=0xffffffff`, `SystemResponsiveness`, tarefa `Games` priorizada |
| Travada de 2–5 s em login, loja, matchmaking ou patch | resolvedor DNS lento/instável (timeout de resolução) | benchmark em 3 camadas (TCP/53, consulta DNS real, ICMP) e aplica o de melhor *score* de estabilidade |
| Hit não registra / personagem "teleporta" | MTU maior que o do caminho ⇒ fragmentação ou queda de pacotes UDP | busca binária com `ping -f -l` e ajuste do MTU da interface ativa |
| "Otimizei" com outro app e a internet piorou | auto-tuning desativado (janela fixa 64 KB), RSS off, BBR prometido sem existir | devolve `autotuninglevel=normal`, `rss=enabled`; congestion provider só se o sistema listar como suportado |

---

## Segurança e reversibilidade (o ponto central do projeto)

1. **Detectar** — lê registro, `netsh`, `powercfg` e CIM. Se o recurso não
   existe no sistema (ex.: Chimney Offload em Windows 11), o ajuste aparece como
   *não suportado* e a ação é desabilitada. Nada é aplicado às cegas.
2. **Backup** — antes de escrever, o valor anterior é gravado em
   `%APPDATA%\willLag\state.json`, **incluindo o caso "o valor não existia"**
   (aí a reversão remove a entrada em vez de zerá-la). Até 5 camadas por ajuste,
   consumidas como pilha: aplicar duas vezes não perde o valor original.
3. **Aplicar e conferir** — depois de escrever, o módulo relê o sistema e só
   reporta sucesso se o alvo estiver realmente lá.
4. **Reverter** — `restoreEngine` monta **um único script PowerShell** com todas
   as entradas (menos prompts de UAC) e trata 12 tipos de restauração.
5. **Ajustes de sessão nunca ficam pendurados** — a pausa da varredura Wi-Fi é
   revertida ao desativar o modo, ao fechar o app, em `uncaughtException`,
   `SIGINT`/`SIGTERM` e por um *watchdog* que revalida gateway+internet a cada
   15 s (3 falhas seguidas ⇒ rollback automático). Se a reversão não for
   possível no encerramento, o log imprime o comando exato
   (`netsh wlan set autoconfig enabled=yes interface="X"`).
6. **UAC tratado** — negar a permissão não quebra nada: o erro chega como
   `UAC_DENIED`, nada é alterado, o backup não é consumido e a UI oferece
   *Reiniciar como Administrador*. O instalador usa `asInvoker` (elevação por
   ação, não o app inteiro como admin).
7. **Sem entrada não sanitizada em shell** — nomes de host, interface, processo e
   valores de registro passam por validação/quoting (`psRunner.psString`,
   `isSafeHost`, `isValidIp`, …) antes de qualquer `powershell`/`netsh`.

Detalhe técnico completo, ajuste por ajuste (chaves, valores padrão, revert):
**[`docs/TWEAKS.md`](docs/TWEAKS.md)**.

---

## Como rodar

Pré-requisitos: Windows 10/11, Node.js 18+ e (para o desktop) Electron.

```bash
npm install                 # dependências
npm run electron-dev        # CRA em :3000 + Electron apontando para ele
npm run electron            # só o shell (se a UI já estiver no ar)
npm run electron-build      # sync-catalog + build + instalador NSIS
```

Sem Electron (navegador), a UI entra em **modo demonstração** com um backend
simulado — textos, riscos e ordem dos ajustes são os reais:

```bash
npm start                   # http://localhost:3000
```

### Testes

```bash
npm test                    # main process + renderer
npm run test:main           # node:test  -> test/*.test.js       (199 testes)
npm run test:renderer       # jest/jsdom -> src/__tests__/*      (115 testes)
npm run verify              # sync-catalog --check + npm test
```

Os testes do processo principal rodam em qualquer SO: fora do Windows os módulos
respondem `UNSUPPORTED_PLATFORM` de forma estruturada, e os parsers
(`netsh`/`powercfg`/`ping`/WLAN) são validados com saídas reais em **pt-BR e
en-US** — o mesmo estado precisa ser reconhecido nos dois idiomas.

### Catálogo compartilhado

`src/shared/tweakCatalog.json` é **gerado** a partir de
`public/services/{tcpip,wifi,dnsService,mtuService}.js`:

```bash
npm run sync-catalog         # regenera
npm run sync-catalog:check   # falha se estiver desatualizado (use no CI)
```

Nunca edite o JSON à mão.

---

## Scripts PowerShell standalone

Para auditoria, automoração e **recuperação sem o app**
(documentação completa em [`scripts/README.md`](scripts/README.md)):

```powershell
.\scripts\Get-WillLagReport.ps1                              # somente leitura
.\scripts\Backup-WillLagNetwork.ps1                          # ponto de restauração
.\scripts\Set-WillLagLowLatency.ps1 -DryRun -IncludeWifi     # o que mudaria
.\scripts\Set-WillLagLowLatency.ps1 -IncludeWifi -DnsProvider cloudflare -Mtu 1492
.\scripts\Restore-WillLagNetwork.ps1                         # desfaz com precisão
```

Compatíveis com Windows PowerShell 5.1, sem sintaxe exclusiva do PowerShell 7.

---

## Arquitetura

```
public/
  electron.js            janela frameless, single-instance, recuperação de crash,
                         encerramento seguro (reverte ajustes de sessão)
  preload.js             window.willlag = { invoke, send, on -> unsubscribe, ... }
                         com contextIsolation e whitelist de canais
  services/
    psRunner.js          execução de PowerShell/netsh/reg/ping, quoting, -EncodedCommand
                         vs. arquivo temporário, classificação de falhas
    registryOps.js       leitura/escrita em lote + entradas de backup por valor
    netInterfaces.js     snapshot de rede (adaptadores, rotas, DNS, WLAN, autoconfig)
    latencyProbe.js      TCP/53, consulta DNS, ICMP; estatísticas (p95, jitter, spike)
    tcpip.js             14 ajustes de pilha TCP/IP e MMCSS
    wifi.js              4 ajustes de Wi-Fi/USB/energia de adaptador
    dnsService.js        benchmark de resolvedores, aplicar/RESTAURAR DNS, cache
    mtuService.js        busca binária de MTU, aplicar/restaurar
    elevation.js         estado de admin, relançar elevado
    stateStore.js        estado em disco, pilhas de backup, lock de sessão, migração
    restoreEngine.js     gera/executa a restauração de todos os tipos de entrada
    tweakRegistry.js     catálogo, presets, ordem de apply/revert, concorrência
    gameMode.js          ciclo de vida do modo (baseline -> apply -> guarda ->
                         watchdog -> rollback), power save blocker
    ipc.js               55 canais de requisição (novos + legacy preservados)
                         e broadcasts de progresso/estado/watchdog
src/
  App.js, components/    UI (LowLatencyMode, TweakRow, ToggleSwitch, MtuPanel,
                         DNSChanger, Optimizer, Dashboard, ProcessList, NetworkMonitor)
  services/ipc.js        ponte única: preload | legacy | demo (mockBackend)
  shared/tweakCatalog.json   gerado
scripts/                 sync do catálogo + 4 scripts PowerShell standalone
test/                    testes do processo principal (node:test)
src/__tests__/           testes de renderer (jest + jsdom)
docs/TWEAKS.md           referência técnica dos ajustes
```

**Compatibilidade com a v1.0:** os canais de IPC antigos
(`optimize-tcp`, `disable-nagle`, `change-dns`, `flush-dns`, `get-processes`,
`set-process-priority`, `start/stop-ping-monitor`, `minimize/maximize/close-window`,
…) continuam respondendo, e as telas existentes foram mantidas. A prioridade
`Low` da UI antiga agora é mapeada para a escala real do Windows (`Idle`).

---

## O que o willLag não faz

* **BBR** — não existe na pilha nativa do Windows; só é aplicado se o sistema
  realmente o listar em `netsh int tcp show supplemental`.
* **Desativar antivírus, firewall ou Windows Update** — não reduz latência de
  forma mensurável e cria risco real.
* **Matar processos do sistema** — a aba *Processos* ajusta prioridade apenas do
  que você escolher; `Realtime` é recusado de propósito.
* **Mexer no roteador** — o app é 100% local. QoS no roteador costuma ajudar mais
  do que qualquer ajuste de SO, e a UI recomenda isso nas dicas.

---

## Solução de problemas

| Problema | Ação |
| --- | --- |
| Tudo aparece como *não suportado* | você não está no Windows, ou o PowerShell está bloqueado por política (`Get-ExecutionPolicy`) |
| "Permissão de Administrador negada" | botão **Reiniciar como Administrador**, ou rode o PowerShell elevado e use os scripts de `scripts/` |
| Caiu a conexão ao pausar a varredura Wi-Fi | a guarda de conectividade reativa sozinha; manualmente: `netsh wlan set autoconfig enabled=yes interface="Wi-Fi"` |
| Quero ver o que está alterado na máquina | `scripts\Get-WillLagReport.ps1` (somente leitura) |
| Quero desfazer tudo sem o app | `scripts\Restore-WillLagNetwork.ps1` (usa o backup mais recente) ou `-Defaults` |
| Log do app | `%APPDATA%\willLag\logs\` e a aba de logs na UI (`get-logs`) |

---

## Licença

MIT. Use por sua conta e risco: o software altera configurações de sistema.
Os mecanismos de backup/reversão existem justamente para isso — leia
[`docs/TWEAKS.md`](docs/TWEAKS.md) antes de aplicar tudo em máquina de produção.
