# Stack Thumbs

Extensão para **Google Chrome** e **Microsoft Edge** (Manifest V3) que detecta os
vídeos do YouTube atualmente **visíveis na tela** e baixa as thumbnails na
**maior resolução disponível**.

Sem bibliotecas externas, sem CDN, sem código remoto — tudo roda dentro da
extensão.

---

## Instalação

1. Abra `chrome://extensions` (no Edge: `edge://extensions`).
2. Ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Escolha a pasta desta extensão (a que contém o `manifest.json`).
5. Abra o YouTube em uma página com listagem de vídeos.
6. Clique no ícone da extensão.

> Se a extensão for instalada/recarregada com abas do YouTube já abertas, ela
> se injeta sozinha nessas abas — não é necessário recarregar a página.

---

## Como usar

Ao abrir o popup, a extensão **já analisa a aba ativa automaticamente**:

```
Abrir extensão → verifica se é YouTube → detecta vídeos visíveis → mostra thumbnails
```

| Ação | O que faz |
|------|-----------|
| **Visíveis na tela** (padrão) | Só os cards ao menos parcialmente dentro do viewport |
| **Todos carregados** | Todos os cards já presentes no DOM da página |
| 🔄 / **Atualizar lista** | Reanalisa a página — use depois de rolar a tela |
| **Baixar tudo em um único `.zip`** | Liga/desliga o modo ZIP (padrão: ligado) |
| **Baixar** (por item) | Baixa aquela thumbnail como `.jpg`, sempre solta |
| **Baixar .zip** / **Baixar selecionadas** | Baixa todas as marcadas de uma vez |
| **Copiar URL** (por item) | Copia a URL da melhor resolução encontrada |
| **Copiar URLs** | Copia as URLs de todas as selecionadas, uma por linha |

Fluxo típico: abrir → baixar → rolar a página → abrir de novo → baixar as novas.

### Onde os arquivos são salvos

**Com o modo ZIP ligado** (padrão), um único arquivo vai para a raiz da sua pasta
de Downloads:

```
youtube-thumbnails-2026-08-16_14-32.zip
├── 01 - Titulo do primeiro video.jpg
├── 02 - Titulo do segundo video.jpg
└── 03 - Titulo do terceiro video.jpg
```

**Com o modo ZIP desligado**, os arquivos vão soltos para a subpasta
`YouTube Thumbnails/`, com a mesma numeração.

Selecionar **um único item** sempre baixa o `.jpg` direto, mesmo com o modo ZIP
ligado — um ZIP com um arquivo só não ajuda ninguém.

Caracteres inválidos no Windows (`< > : " / \ | ? *`) são removidos, títulos
muito longos são cortados em 80 caracteres e nomes reservados (`CON`, `NUL`,
`COM1`…) recebem prefixo. Sem título disponível, o nome usa o `videoId`.
A numeração é sempre contígua: se uma imagem falhar, as seguintes não deixam
buraco.

---

## Estrutura do projeto

```
ext_yout/
├── manifest.json              # MV3: permissões, content script, action, ícones
├── popup/
│   ├── popup.html             # markup + <template> do item da lista
│   ├── popup.css              # tema claro/escuro automático
│   └── popup.js               # orquestra detecção, resolução e downloads
├── content/
│   └── content.js             # varre o DOM do YouTube sob demanda
├── background/
│   └── service-worker.js      # único ponto que chama chrome.downloads
├── offscreen/
│   ├── offscreen.html         # documento invisível, criado sob demanda
│   └── offscreen.js           # busca as imagens e monta o ZIP
├── shared/
│   ├── protocol.js            # contrato de mensagens
│   ├── youtube.js             # extractYouTubeVideoId + variantes de thumbnail
│   ├── filename.js            # sanitização de nomes de arquivo
│   └── zip.js                 # gerador de ZIP (CRC-32 + formato, sem libs)
├── icons/                     # 16 / 32 / 48 / 128 px
└── README.md
```

Os arquivos de `shared/` são scripts clássicos que se expõem em `globalThis`, o
que permite carregá-los nos três contextos sem build step:

| Contexto | Como carrega |
|----------|--------------|
| content script | `manifest.content_scripts.js` |
| popup | `<script src>` |
| service worker | `importScripts()` |

### Comunicação

```
popup ──chrome.tabs.sendMessage──▶ content script ──▶ DOM do YouTube
popup ──chrome.runtime.sendMessage──▶ service worker ──▶ chrome.downloads
                                            │
                                            └──▶ offscreen ──▶ fetch + ZIP + blob URL
```

### Permissões e por quê

| Permissão | Motivo |
|-----------|--------|
| `downloads` | Baixar as thumbnails sem abrir abas |
| `scripting` | Injetar o content script em abas abertas antes da instalação |
| `storage` | Lembrar o modo de captura e a preferência de ZIP |
| `offscreen` | Montar o ZIP (ver abaixo) |
| `host_permissions` do youtube.com | Ler o DOM da página para achar os cards |
| `host_permissions` do i.ytimg.com | Buscar os bytes das imagens para o ZIP |

> O `i.ytimg.com` hoje responde `Access-Control-Allow-Origin: *`, então o `fetch`
> funcionaria sem a permissão. Ela está declarada de propósito, para o ZIP não
> quebrar se o YouTube mudar essa configuração.

---

## Como funciona

### Detecção de vídeos

A varredura parte de `href`, não de classes CSS internas do YouTube (que mudam
sem aviso):

```
a[href*="/watch?v="], a[href*="/shorts/"], a[href*="youtu.be/"], a[href*="/embed/"]
```

Para cada âncora, o card é localizado subindo a árvore: primeiro por tag
conhecida (`ytd-rich-item-renderer`, `yt-lockup-view-model`, `ytd-video-renderer`…),
e se nenhuma casar, por **fallback geométrico** (primeiro ancestral com tamanho
de card). Cards encontrados só pela geometria precisam conter uma thumbnail de
verdade — é isso que impede que links de vídeo dentro de **comentários** e
**descrições** virem falsos positivos.

Visível = o card intersecta o viewport em ao menos 1 pixel:

```js
const rect = element.getBoundingClientRect();
const visible = rect.bottom > 0 && rect.right > 0
             && rect.top < window.innerHeight && rect.left < window.innerWidth;
```

Duplicatas são eliminadas por `videoId`, mantendo a melhor ocorrência (visível
antes de não visível, card maior antes de menor) e completando título/thumbnail
a partir da ocorrência descartada.

A ordem final é a **ordem visual**: as linhas são agrupadas com tolerância
proporcional à altura dos cards (para não embaralhar um grid por diferenças de
poucos pixels) e ordenadas de cima para baixo, da esquerda para a direita.

### Resolução da thumbnail

```
maxresdefault (1280×720)
      ↓ inválida?
sddefault (640×480)
      ↓ inválida?
hqdefault (480×360)
      ↓ inválida?
mqdefault (320×180)
      ↓ inválida?
"thumbnail indisponível" (item desmarcado)
```

Quando a variante não existe, o `i.ytimg.com` responde **404 com um corpo de
imagem placeholder de 120×90** — não com um erro limpo. Por isso a validação é
dupla: o `onerror` do `<img>` pega o 404, e as dimensões carregadas são
comparadas com o mínimo esperado da variante (120×90 é rejeitado explicitamente).

Cada tentativa tem **timeout de 6s**, a verificação roda com no máximo **6
requisições simultâneas**, e o resultado é cacheado por `videoId` — a UI nunca
fica travada esperando uma requisição pendurada, e cada item atualiza sozinho
assim que resolve.

### Download em ZIP

O ZIP é gerado pela própria extensão, sem biblioteca externa
(`shared/zip.js`: CRC-32 + formato do arquivo, ~200 linhas). Ele usa o método
**store** (sem compressão) de propósito: JPEG já é um formato comprimido, então
passar deflate nele gastaria CPU para ganhar quase nada. O overhead do container
é de ~170 bytes por arquivo.

O caminho até o download precisa de três contextos por causa de duas restrições
do Manifest V3:

1. um **service worker não tem `URL.createObjectURL`** — não consegue transformar
   os bytes do ZIP em algo baixável;
2. o **`chrome.runtime.sendMessage` serializa em JSON** — passar megabytes de
   binário entre contextos por mensagem seria inviável.

Por isso quem busca as imagens e monta o ZIP é um **offscreen document**, que
gera a blob URL e devolve apenas a *string* ao service worker:

```
popup ──▶ service worker ──▶ cria offscreen document
                                    │
                                    ├─ fetch das imagens (4 em paralelo, timeout 15s)
                                    ├─ monta o ZIP
                                    └─ devolve a blob URL
                             ◀──────┘
          service worker ──▶ chrome.downloads.download(blob URL)
          service worker ──▶ espera o download terminar ──▶ fecha o offscreen
```

O offscreen document é usado — em vez de montar o ZIP no popup — porque o popup
morre no instante em que o usuário clica fora dele, o que revogaria a blob URL
no meio do download.

Enquanto as imagens são buscadas, o offscreen informa o progresso ao popup
(`Compactando 3/10…`). Se alguma imagem falhar, ela é deixada de fora e o ZIP sai
com as demais, renumeradas sem buraco; se **todas** falharem, nenhum download é
disparado e aparece uma mensagem de erro.

### YouTube como SPA

Nada depende de `DOMContentLoaded` nem de `MutationObserver` permanente: o DOM é
lido **no instante em que o popup pede**. Navegações internas do YouTube (que não
recarregam a página) e scroll são cobertos naturalmente por isso.

---

## Como testar

**Cenário 1 — grid de canal.** Abra `youtube.com/@umcanal/videos` e clique na
extensão. Só os cards realmente na tela devem aparecer, na ordem em que estão.

**Cenário 2 — scroll.** Role a página para baixo e clique em 🔄. A lista deve
trocar pelos vídeos agora visíveis.

**Cenário 3 — sem maxresdefault.** Teste com um vídeo antigo (ex.: `jNQXAC9IVRw`,
"Me at the zoo"): ele não tem `maxresdefault` nem `sddefault`, e o item deve
mostrar `480 × 360` com o selo `HQ`.

**Cenário 4 — duplicatas.** Numa página de busca ou playlist, onde a thumbnail e
o título são links separados para o mesmo vídeo, cada vídeo deve aparecer
**uma vez só**.

**Cenário 5 — download em massa.** Marque 10 itens e clique em **Baixar .zip** —
deve baixar **um** arquivo `.zip` com as 10 thumbnails numeradas dentro, sem
abrir nenhuma aba. Desligue o toggle e repita: agora devem ser 10 arquivos
soltos em `YouTube Thumbnails/`.

**Cenário 6 — página errada.** Abra `google.com` e clique na extensão:
_"Abra uma página do YouTube para utilizar a extensão."_

**Cenário 7 — área sem vídeos.** Role até uma parte da página sem cards:
_"Nenhum vídeo encontrado na área visível."_

Páginas cobertas: home, canal, `/videos`, busca, playlists, inscrições,
vídeos relacionados e Shorts.

---

## Limitações conhecidas

- **A resolução máxima depende do YouTube.** Se o canal nunca enviou uma
  thumbnail em HD, `maxresdefault` não existe e o melhor possível é `480 × 360`.
  A extensão não inventa resolução — ela mostra o que realmente conseguiu.
- **Vídeos privados/removidos** não têm thumbnail em nenhuma variante: o item
  aparece como "thumbnail indisponível" e é desmarcado automaticamente.
- **Modo "Todos carregados" ≠ todos do canal.** Ele lê o que já está no DOM; o
  YouTube usa scroll infinito e recicla os cards antigos. Para pegar mais, role
  a página antes.
- **Um card em transição** (sendo reciclado pelo virtual scroller no exato
  momento da leitura) pode ficar de fora. Clicar em 🔄 resolve.
- **Layout mobile (`m.youtube.com`)** é suportado pelo fallback geométrico, mas
  foi menos exercitado que o desktop.
- **A ordem visual é reconstruída por geometria.** Em layouts muito atípicos
  (carrosséis horizontais dentro de grids) a numeração pode divergir da
  percepção visual.
- **Downloads em massa muito grandes** (centenas de itens) são disparados em
  sequência com intervalo de 120 ms para não serem estrangulados pelo Chrome.
- **O ZIP não comprime** (método store) — o arquivo tem praticamente o tamanho
  da soma dos JPEGs. Isso é intencional: JPEG já é comprimido. O ganho do ZIP
  aqui é organização (um arquivo em vez de dezenas), não tamanho.
- **O ZIP é montado na memória.** Para as centenas de itens que a extensão
  detecta na prática isso é irrelevante (~50 MB no pior caso), mas o formato
  clássico limita a 65.535 arquivos e 4 GB — acima disso a extensão avisa em vez
  de gerar um arquivo corrompido.
- **O modo ZIP exige Chrome/Edge 109+** (API `chrome.offscreen`). Em navegadores
  mais antigos a extensão avisa; o download individual continua funcionando.
- **Só thumbnails.** A extensão não baixa vídeos.

---

## Extensões futuras

A arquitetura já separa detecção (content script), resolução (popup) e entrega
(service worker), o que abre espaço para:

- baixar as thumbnails de todos os vídeos de um canal;
- histórico de downloads e "baixar somente as novas";
- incluir um `.csv`/`.json` com os metadados dentro do próprio ZIP
  (`shared/zip.js` aceita qualquer arquivo, não só imagens);
- captura de views/data de publicação (o content script já devolve o card);
- exportação em JSON/CSV;
- filtros e seleção por intervalo.

O objeto devolvido pelo content script é o ponto de extensão natural:

```js
{
  videoId: "dQw4w9WgXcQ",
  title: "Título do vídeo",
  videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  pageThumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  top: 120, left: 0, width: 300, height: 250,
  visible: true, visibleRatio: 1, occurrences: 2, position: 1
}
```
