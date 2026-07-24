# Análise do repositório — preparação para publicação

> Auditoria de código feita em 2026-07-24, com o objetivo de "fechar o pacote":
> definir identidade, corrigir bugs, cortar o que não faz sentido e listar o que
> falta para publicar.

## 1. O que o produto é hoje

Extensão Chrome (Manifest V3) com dois conjuntos de recursos:

| Plataforma | Recursos |
|---|---|
| Instagram | Copiar imagem (menu de contexto), baixar vídeo de Reels, extrair áudio (WAV), **transcrever com Whisper rodando 100% local** (Transformers.js + ONNX WASM em offscreen document) |
| YouTube *(removido)* | Painel de transcrição usando as legendas oficiais do player |

A parte tecnicamente mais valiosa é a transcrição local: privada, sem servidor,
sem custo por uso. A parte mais frágil é a extração de vídeo do Instagram
(engenharia reversa de React fiber + manifest DASH + API interna), que quebra a
cada redesign da Meta.

## 2. Identidade

Problemas encontrados:

- Nome do repo (`social-copy-plugin`) ≠ nome no manifest (`Media Toolkit`) ≠
  prefixos de código (`ig-toolkit`, `yt-toolkit`).
- Versão `3.0` com apenas 2 commits de histórico.
- UI 100% em pt-BR hardcoded, sem `_locales`/i18n — decisão implícita de
  produto brasileiro que nunca foi explicitada.
- Whisper (o diferencial) existia só no Instagram; o YouTube usava legendas
  prontas — assimetria difícil de explicar em uma frase de loja.

**Direção proposta:** centrar a identidade na transcrição local
("transcreva Reels 100% no seu navegador, sem enviar nada para servidor"),
com download de vídeo/áudio e cópia de imagem como recursos secundários.
O suporte a YouTube foi removido (ver §4) para fechar o escopo em Instagram.

## 3. Bug corrigido: transcrição de reel errado

**Sintoma relatado:** ao extrair reels a partir de um perfil, a extensão às
vezes transcrevia conteúdo de reels desconhecidos.

**Causa raiz (confirmada no código):** `extractVideoFromPage()` em
`background.js` busca dados de mídia no estado do React em cascata: fiber do
`<video>` → dialog → article → pais → *árvore React inteira da página* (último
recurso). Numa página de perfil, o estado do React contém dados de **muitos
reels** (grid do perfil, pré-carregados, sugestões). O `deepSearch` aceitava o
**primeiro** `video_versions`/manifest DASH encontrado, sem verificar a qual
reel pertencia. Havia uma checagem de "shortcode mismatch" para o vídeo, mas
ela **não se aplicava ao `audioUrl`** — e a transcrição prefere justamente o
áudio (`media.audioUrl || media.videoUrl`). Resultado: o Whisper transcrevia o
áudio de outro reel carregado em memória. Nada era "inventado".

**Correção aplicada:**

1. O shortcode do reel alvo (extraído da URL/DOM pelo content script) agora é
   injetado no MAIN world (`window.__igToolkitTargetShortcode`) antes da
   extração.
2. `deepSearch` **poda** qualquer subárvore de objeto de mídia cujo
   `code`/`shortcode` seja diferente do alvo, e só **colhe** URLs (vídeo E
   áudio), `pk`/`mediaId` de objetos comprovadamente do reel alvo
   (flags `verifiedVideo`/`verifiedAudio`).
3. Os fallbacks de busca ampla continuam existindo, mas agora param apenas em
   dados verificados quando há alvo conhecido (`haveTargetVideo`).
4. Se nada verificado for encontrado, o fluxo cai no fetch direto da página
   `/reel/<shortcode>/` — correto por construção. A extensão agora **falha
   explicitamente** em vez de devolver mídia de outro reel.
5. Sem shortcode conhecido (ex.: vídeo de feed sem permalink próximo), o
   comportamento permissivo antigo é mantido como fallback.

## 4. Decisão: YouTube removido

Removido nesta rodada (`youtube-content.js`, `youtube-styles.css`, entradas do
manifest, handlers `getYouTubeCaptionTracks`/`fetchCaptions` no background):

- Fechava mal com a identidade (não usava Whisper, só legendas prontas).
- Reduz superfície de permissões (`youtube.com`, `googlevideo.com` fora do
  manifest) — menos atrito na revisão da Chrome Web Store.
- A menção a YouTube na descrição era um risco de política da CWS (extensões
  de download de YouTube são banidas; mesmo sendo só transcrição, a descrição
  antiga dizia "download videos ... from Instagram and YouTube").

O código era autocontido e está no histórico do git — fácil de ressuscitar como
feature separada se fizer sentido depois. `transcript-panel.js` (o painel
compartilhado) permanece, pois é usado pela transcrição do Instagram.

## 5. Bugs conhecidos (backlog, em ordem de impacto)

1. **Promises penduradas travam os botões** — `safeSendMessage` em
   `content.js` engole erros sem chamar o callback; `extractMediaUrls` e
   `transcribeVideo` fazem `await` de Promises que nunca resolvem se o
   background falhar. `isDownloading`/`isTranscribing` ficam presos em `true`
   até recarregar a página. Precisa de timeout + rejeição explícita.
2. **Transcrições concorrentes se atropelam** — `offscreen.js` reatribui
   `worker.onmessage` a cada job. Duas abas transcrevendo ao mesmo tempo:
   a primeira nunca resolve e o progresso vaza para a aba errada. Precisa de
   fila ou IDs de job.
3. **Vídeos grandes estouram o pipeline** — `fetchVideoData` baixa o vídeo
   inteiro, converte para base64 (+33%) e envia via `sendResponse` (limite de
   ~64 MB de mensagem). Reels longos/HD falham silenciosamente. O vídeo também
   é baixado duas vezes (uma para extrair áudio, outra pelo offscreen).
4. **Re-injeção incompleta no menu de contexto** — `background.js` injeta só
   `content.js` (sem `transcript-panel.js` nem `styles.css`) ao clicar no menu.
   Instalou a extensão com a página aberta → "Transcrever" quebra e botões
   ficam sem estilo.
5. **`fetchImage` com concatenação O(n²)** — monta string binária byte a byte
   (o `fetchVideoData` logo abaixo faz em chunks — inconsistente). Data URL
   sempre rotulado `image/jpeg` mesmo para webp/png.
6. **HTML injection no seletor de idiomas** — `transcript-panel.js` insere
   `l.name` (dado externo) em `innerHTML` sem escape; o resto do painel usa
   `escapeHtml`. Com o YouTube removido o vetor sumiu (Instagram passa lista
   vazia), mas o componente deve escapar sempre.
7. **Fragilidade do service worker MV3** — a cadeia content → background →
   offscreen depende de callbacks vivos por minutos durante a transcrição; os
   eventos de progresso mantêm o SW vivo por acaso, não por design. Fase longa
   sem progresso pode derrubar tudo.

## 6. Fluxos estranhos / dívidas

- **"Extrair Áudio" converte AAC → WAV**: o áudio DASH já é um `.m4a`
  tocável; a extensão decodifica e re-encoda para WAV sem compressão (~10x
  maior), com todo o custo de memória do item 3 acima. Baixar o `.m4a` direto
  via `chrome.downloads` resolveria.
- **`downloadAudioFile` e `extractAudio` são idênticas** em `content.js` —
  só muda o texto do toast. Unificar.
- **Polling perpétuo** (`setInterval(checkPage, 1500)`) com
  `querySelectorAll("video")` na página toda; trocar por `MutationObserver`.
- **Idioma do Whisper hardcoded `"portuguese"`** — reel em inglês sai com
  transcrição ruim sem aviso. O painel já suporta seletor de idiomas; ligar.
- **Menu de contexto com `contexts: ["all"]`** — deveria ser `["image"]`,
  eliminando a heurística de "adivinhar a imagem mais próxima".
- **`console.log` verboso**, inclusive em código injetado no MAIN world
  (vaza URLs de mídia no console da página do usuário).

## 7. Código morto / não usado

- `type: "preload"` no `whisper-worker.js`: ninguém envia. Ou implementar o
  pré-carregamento do modelo (faz muito sentido — o modelo tem centenas de MB)
  ou remover.
- Campo numérico `progress` propagado por toda a cadeia de mensagens, mas o
  painel só usa a string `message`.
- `formatTimestamp` exportado na API pública do painel sem consumidor externo.
- Permissão `activeTab` provavelmente redundante frente aos `host_permissions`.
- ~190 linhas de CSS do painel estavam duplicadas entre `styles.css` e
  `youtube-styles.css` (resolvido com a remoção do YouTube).

## 8. Bloqueadores de publicação (Chrome Web Store)

- [ ] **README** com descrição, screenshots e instruções de instalação.
- [ ] **LICENSE**.
- [ ] **Política de privacidade** (obrigatória com essas permissões; ponto
      forte: "nenhum dado sai do navegador").
- [ ] **Decisão consciente sobre o download de Instagram**: viola o ToS da
      Meta; downloaders de IG existem na loja, mas é um risco de takedown a
      assumir explicitamente.
- [ ] **Nome/identidade única**: alinhar repo, manifest e prefixos de código.
- [ ] **i18n ou decisão explícita de pt-BR only** (`default_locale`).
- [ ] Pacote de ~24 MB por causa do WASM do ONNX (`lib/`, vendorizado sem
      LFS) — aceitável na CWS, mas vale documentar o porquê.
- [ ] Avisar o usuário no primeiro uso da transcrição que um modelo de
      centenas de MB será baixado do HuggingFace.

## 9. Roadmap sugerido

1. ~~Corrigir bug do reel errado~~ ✅ (esta rodada)
2. ~~Remover YouTube~~ ✅ (esta rodada)
3. Corrigir itens 1–4 do backlog de bugs (§5) — são os que o usuário sente.
4. Simplificar "Extrair Áudio" para baixar o `.m4a` direto (§6).
5. Definir nome/identidade e alinhar manifest + repo + README + loja.
6. Escrever README, LICENSE e política de privacidade.
7. Publicar.
