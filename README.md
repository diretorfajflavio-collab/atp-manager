# ATP Manager — Aplicativo de Desktop

Versão desktop do ATP Manager: um aplicativo instalável (Windows, Mac e Linux)
que substitui o antigo agente em Python, os scripts `.bat` e o Agendador de
Tarefas do Windows por **um único programa com interface gráfica**.

O usuário final baixa **um arquivo**, dá dois cliques para instalar, e configura
tudo por telas — sem linha de comando, sem ZIP, sem instalar Python ou navegador.

---

## O que mudou em relação ao agente Python

| Antes (agente Python v3.4.6) | Agora (app desktop v4.0.0) |
|---|---|
| Instalar Python manualmente | Nada a instalar além do próprio app |
| Instalar Playwright + navegador via terminal | Navegador (Chromium) já vem embutido |
| Editar e rodar arquivos `.bat` | Tudo por interface gráfica |
| Configurar 4 tarefas no Agendador do Windows | Agendamento interno automático |
| Token e senha em arquivo de texto | Guardados de forma protegida pelo sistema |
| Só Windows | Windows, Mac e Linux |

A lógica de automação (login SSO TJSP em duas etapas, detecção de PJ Autora,
navegação por localizadores, paginação, renovação de cookies) foi **portada
fielmente** do `atp_agent.py` para Node.js/Playwright.

---

## Estrutura do projeto

```
src/
  main/         Processo principal do Electron
    main.js       Janela, bandeja do sistema, ponte com a interface
    store.js      Configuração local protegida (sem banco de dados)
    preload.js    Ponte segura entre interface e lógica
    scheduler.js  Agendador interno (substitui Task Scheduler + .bat)
  agent/
    agentRunner.js  Conexão eproc, login SSO, keepalive, diagnóstico
    rulesEngine.js  Motor de regras ATP (PJ Autora, localizadores, ações)
  renderer/     Interface gráfica (HTML/CSS/JS)
build/          Ícones do app
test/           Testes da lógica crítica
.github/workflows/build.yml   Compila os 3 instaladores automaticamente
```

---

## Como gerar os instaladores (sem usar terminal na sua máquina)

A forma recomendada usa o **GitHub Actions** — o GitHub compila os três
instaladores para você, na nuvem. Você nunca precisa rodar build localmente.

1. Suba este projeto para um repositório no GitHub (pode ser privado).
2. Crie uma "tag" de versão chamada `v4.0.0` (pela interface do GitHub:
   *Releases → Draft a new release → escolher uma tag → v4.0.0 → Publish*).
3. O GitHub compila sozinho e anexa os instaladores ao release:
   - `ATP-Manager-Setup-4.0.0.exe` (Windows)
   - `ATP-Manager-4.0.0.dmg` (Mac)
   - `ATP-Manager-4.0.0.AppImage` (Linux)
4. Pronto: é só baixar e distribuir. O código-fonte permanece sob seu controle.

> Para compilar manualmente (caso queira), num computador com Node.js:
> `npm install && npm run dist`. Cada instalador só é gerado no sistema
> operacional correspondente.

---

## Como o usuário final usa

1. Baixa e instala o app (dois cliques).
2. Abre o programa. Na aba **Configuração**:
   - Cola o **código de acesso** do painel (página Integração eproc).
   - Informa **usuário e senha do eproc**.
   - Escolhe **dias e horários** da verificação automática.
3. Clica em **Salvar**. Acabou.

O programa fica na bandeja do sistema, inicia junto com o computador e faz as
verificações sozinho nos horários escolhidos. A qualquer momento dá para abrir
e clicar em **Executar verificação agora**.

---

## Testes

```
node test/logic.test.js
```

Cobrem o matching de regras, o cálculo de dias úteis (com feriados nacionais)
e a detecção de sessão expirada — a lógica mais sensível do sistema.

---

## Configuração de conexão

Por padrão o app conecta ao painel em
`https://eprocassist-a42rkir7.manus.space`. Esse endereço é **editável** na
própria interface — se um dia o backend mudar de lugar, basta atualizar o campo
"Endereço do painel", sem recompilar nada.

---

## Refinamentos da versão atual

- **Assistente de primeiro uso**: na primeira abertura, um passo a passo guiado
  (3 telas) coleta o código de acesso e as credenciais, sem despejar o usuário
  na tela cheia.
- **Banner de saúde**: a aba Início mostra, em uma frase, se está "Tudo certo"
  ou o que falta configurar — com botão de atalho para resolver.
- **Mensagens humanas**: erros técnicos (timeout, 401, sessão expirada) são
  traduzidos em orientações claras do que fazer, tanto na interface quanto no
  histórico. Centralizadas em `src/shared/messages.js` e cobertas por testes.
- **Resiliência de rede**: a conexão ao eproc tenta até 3 vezes com espera
  crescente, tolerando oscilações da rede do tribunal.
- **Lote à prova de falhas**: um erro em um processo isolado é registrado
  naquele processo e não interrompe a verificação dos demais.
- **Senha protegida**: guardada via cofre do sistema operacional (safeStorage)
  quando disponível; nunca trafega em texto puro para a interface nem fica
  legível no arquivo de configuração.

---

## Recursos de validação (sem precisar ir ao tribunal)

- **Testar sem alterar (simulação)**: percorre todo o fluxo no eproc — encontra
  os processos, detecta PJ Autora — mas **não altera nada**. Apenas relata o que
  faria. Não envia resultado ao painel nem suja o histórico real. É a forma
  segura de conferir se a leitura do eproc está correta antes de rodar de verdade.
- **Captura de tela em falha**: quando um seletor não é encontrado, o programa
  salva automaticamente uma imagem da tela do eproc naquele instante, na pasta
  de diagnóstico (acessível pelo botão "Abrir pasta de diagnóstico" na aba
  Diagnóstico). Acelera muito a correção de seletores que mudem no eproc.

Esses dois recursos juntos permitem validar e ajustar o sistema observando o
comportamento real, com risco zero de alterar processos indevidamente.

---

## Versão 4.0.1 — Ajustes do login eproc

- **Login de etapa única**: o preenchimento de usuário e senha na mesma tela
  (formato usado pelo eproc TJSP) foi corrigido. A detecção agora se baseia na
  existência do campo de senha, não na sua visibilidade — resolvendo o caso em
  que o campo vem oculto via CSS.
- **Autenticação de dois fatores (2FA)**: o navegador do programa agora usa um
  **perfil persistente**, que guarda os cookies e a confiança do dispositivo
  entre execuções. O código 2FA é pedido apenas na primeira vez.
- **Botão "Fazer login manual (1ª vez)"**: abre o navegador visível para o
  primeiro acesso, permitindo digitar o código 2FA e marcar "não pedir
  novamente neste dispositivo". A partir daí, as verificações automáticas rodam
  sem pedir o código.
