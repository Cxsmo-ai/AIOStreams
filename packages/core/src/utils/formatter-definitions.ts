export type FormatterDefinition = { name: string; description: string };

export const BUILTIN_FORMATTER_DEFINITIONS: Record<
  string,
  FormatterDefinition
> = {
  torrentio: {
    name: `{stream.proxied::istrue["🕵️‍♂️ "||""]}{stream.private::istrue["🔑 "||""]}{stream.type::=p2p["[P2P] "||""]}{service.id::exists["[{service.shortName}"||""]}{service.cached::istrue["+] "||""]}{service.cached::isfalse[" download] "||""]}{addon.name} {stream.resolution::exists["{stream.resolution}"||"Unknown"]}
{?{stream.visualTags::join(' | ')}?}`,
    description: `{?ℹ️{stream.message}?}
{?{stream.folderName}?}
{?{stream.filename}?}
{stream.size::>0["💾{stream.size::bytes2} "||""]}{stream.folderSize::>0["/ 💾{stream.folderSize::bytes2}"||""]}{stream.seeders::>=0["👤{stream.seeders} "||""]}{?📅{stream.age} ?}{?⚙️{stream.indexer}?}
{?{stream.languageEmojis::join(' / ')}?}{stream.subtitles::exists::and::stream.languageEmojis::exists[" "||""]}{stream.subtitles::exists["Subs / {stream.subtitleEmojis::join(' / ')}"||""]}
`,
  },
  torbox: {
    name: `{stream.proxied::istrue["🕵️‍♂️ "||""]}{stream.private::istrue["🔑 "||""]}{stream.type::=p2p["[P2P] "||""]}{addon.name}{stream.library::istrue[" (Your Media) "||""]}{service.cached::istrue[" (Instant "||""]}{service.cached::isfalse[" ("||""]}{service.id::exists["{service.shortName})"||""]}{? ({stream.resolution})?}`,
    description: `Quality: {stream.quality::exists["{stream.quality}"||"Unknown"]}
Name: {stream.filename::exists["{stream.filename}"||"Unknown"]}
Size: {stream.size::>0["{stream.size::bytes} "||""]}{stream.folderSize::>0["/ {stream.folderSize::bytes} "||""]}{?| Source: {stream.indexer} ?}{stream.duration::>0["| Duration: {stream.duration::time} "||""]}
Languages: {?{stream.languages::join(', ')}?}{stream.subtitles::exists::and::stream.languages::exists[" | "||""]}{?Subtitles: {stream.subtitles::join(', ')}?}
{?Message: {stream.message}?}`,
  },
  gdrive: {
    name: `{stream.proxied::istrue["🕵️ "||""]}{stream.private::istrue["🔑 "||""]}{stream.type::=p2p["[P2P] "||""]}{?[{service.shortName}?}{service.cached::istrue["⚡] "||""]}{service.cached::isfalse["⏳] "||""]}{addon.name}{stream.library::istrue[" (Your Media)"||""]} {?{stream.resolution}?}{stream.seadexBest::istrue[" (Best)"||""]}{stream.seadex::istrue::and::stream.seadexBest::isfalse[" (SeaDex Alt.)"||""]}{stream.rseMatched::exists::and::stream.seadex::isfalse::and::stream.rseMatched::string::~T1::or::stream.rseMatched::string::~T2::or::stream.rseMatched::string::~T3::or::stream.rseMatched::string::~T4::or::stream.rseMatched::string::~T5::or::stream.rseMatched::string::~T6::or::stream.rseMatched::string::~T7::or::stream.rseMatched::string::~T8[" ({stream.rseMatched::first})"||""]}{stream.regexMatched::exists::and::stream.rseMatched::exists::isfalse::and::stream.seadex::isfalse[" ({stream.regexMatched})"||""]}`,
    description: `{?🎥 {stream.quality} ?}{?🎞️ {stream.encode} ?}{?🏷️ {stream.releaseGroup} ?}{?📡 {stream.network} ?}
{?📺 {stream.visualTags::join(' | ')} ?}{?🎧 {stream.audioTags::join(' | ')} ?}{?🔊 {stream.audioChannels::join(' | ')}?}
{stream.size::>0["📦 {stream.size::sbytes} "||""]}{stream.folderSize::>0["/ {stream.folderSize::sbytes} "||""]}{stream.bitrate::>0["({stream.bitrate::sbitrate})"||""]}{stream.duration::>0["⏱️ {stream.duration::time} "||""]}{stream.seeders::>0["👥 {stream.seeders} "||""]}{?📅 {stream.age} ?}{?🔍 {stream.indexer}?}
{?🌎 {stream.languages::join(' | ')}?}{?📝 {stream.subtitles::join(' | ')}?}
{stream.filename::exists["📁"||""]} {?{stream.folderName}/?}{?{stream.filename}?}
{?ℹ️ {stream.message}?}
      `,
  },
  lightgdrive: {
    name: `{stream.proxied::istrue["🕵️ "||""]}{stream.private::istrue["🔑 "||""]}{stream.type::=p2p["[P2P] "||""]}{?[{service.shortName}?}{stream.library::istrue["☁️"||""]}{service.cached::istrue["⚡] "||""]}{service.cached::isfalse["⏳] "||""]}{addon.name}{? {stream.resolution}?}{stream.seadexBest::istrue[" (Best)"||""]}{stream.seadex::istrue::and::stream.seadexBest::isfalse[" (SeaDex Alt.)"||""]}{stream.rseMatched::exists::and::stream.seadex::isfalse::and::stream.rseMatched::string::~T1::or::stream.rseMatched::string::~T2::or::stream.rseMatched::string::~T3::or::stream.rseMatched::string::~T4::or::stream.rseMatched::string::~T5::or::stream.rseMatched::string::~T6::or::stream.rseMatched::string::~T7::or::stream.rseMatched::string::~T8[" ({stream.rseMatched::first})"||""]}{stream.regexMatched::exists::and::stream.rseMatched::exists::isfalse::and::stream.seadex::isfalse[" ({stream.regexMatched})"||""]}`,
    description: `{?📁 {stream.title::title}?}{? ({stream.year})?}{? {stream.seasonEpisode::join(' • ')}?}
{?🎥 {stream.quality} ?}{?🎞️ {stream.encode} ?}{?🏷️ {stream.releaseGroup}?}{?📡 {stream.network} ?}
{?📺 {stream.visualTags::join(' • ')} ?}{?🎧 {stream.audioTags::join(' • ')} ?}{?🔊 {stream.audioChannels::join(' • ')}?}
{stream.size::>0["📦 {stream.size::sbytes} "||""]}{stream.folderSize::>0["/ {stream.folderSize::sbytes} "||""]}{stream.duration::>0["⏱️ {stream.duration::time} "||""]}{?📅 {stream.age} ?}{?🔍 {stream.indexer}?}
{?🌐 {stream.languageEmojis::join(' / ')}?}{stream.subtitles::exists["📝 {stream.subtitleEmojis::join(' / ')}"||""]}
{?ℹ️ {stream.message}?}`,
  },
  minimalisticgdrive: {
    name: `{stream.resolution::exists["{stream.resolution::replace('2160p','✨ 4K')::replace('1440p','📀 2K')::replace('1080p','🧿1080p')::replace('720p','💿720p')}"||"N/A"]}{service.cached::istrue[" 🎫 "||""]}{service.cached::isfalse[" 🎟️ "||""]}
{?{stream.quality::upper}?}
`,
    description: `{?🔆 {stream.visualTags::join(' • ')}  ?}{?🔊 {stream.audioTags::join(' • ')}?}
{stream.size::>0["📦 {stream.size::sbytes} "||""]}
{?🌎 {stream.languages::join(' • ')}?}{?📝 {stream.subtitles::join(' • ')}?}
`,
  },
  prism: {
    name: `{stream.resolution::exists["{stream.resolution::replace('2160p', '🔥4K UHD')::replace('1440p','✨ QHD')::replace('1080p','🚀 FHD')::replace('720p','💿 HD')::replace('576p','💩 Low Quality')::replace('480p','💩 Low Quality')::replace('360p','💩 Low Quality')::replace('240p','💩 Low Quality')::replace('144p','💩 Low Quality')}"||"💩 Unknown"]}`,
    description: `{?🎬 {stream.title::title} ?}{?({stream.year}) ?}{?🍂 {stream.formattedSeasons} ?}{?🎞️ {stream.formattedEpisodes}?}{stream.seadexBest::istrue["🎚️ Best "||""]}{stream.seadex::istrue::and::stream.seadexBest::isfalse["🎚️ Alternative"||""]}{stream.rseMatched::exists::and::stream.seadex::isfalse::and::stream.rseMatched::string::~T1::or::stream.rseMatched::string::~T2::or::stream.rseMatched::string::~T3::or::stream.rseMatched::string::~T4::or::stream.rseMatched::string::~T5::or::stream.rseMatched::string::~T6::or::stream.rseMatched::string::~T7::or::stream.rseMatched::string::~T8[" 🎚️ {stream.rseMatched::first}"||""]}{stream.regexMatched::exists::and::stream.rseMatched::exists::isfalse::and::stream.seadex::isfalse["🎚️ {stream.regexMatched} "||""]}
{?🎥 {stream.quality} ?}{?📺 {stream.visualTags::join(' | ')} ?}{?🎞️ {stream.encode} ?}{stream.duration::>0["⏱️ {stream.duration::time} "||""]}
{?🎧 {stream.audioTags::join(' | ')} ?}{?🔊 {stream.audioChannels::join(' | ')} ?}{stream.languages::exists["🗣️ {stream.languageEmojis::join(' / ')}"||""]}{stream.subtitles::exists["📝 {stream.subtitleEmojis::join(' / ')}"||""]}
{stream.size::>0["📦 {stream.size::sbytes} "||""]}{stream.folderSize::>0["/ {stream.folderSize::sbytes} "||""]}{stream.bitrate::>0["📊 {stream.bitrate::sbitrate} "||""]}{service.cached::isfalse::or::stream.type::=p2p::and::stream.seeders::>0["🌱 {stream.seeders} "||""]}{stream.type::=usenet::and::stream.age::exists["📅 {stream.age} "||""]}
{?🏷️ {stream.releaseGroup} ?}{?📡 {stream.indexer} ?}{?🎭 {stream.network}?}
{service.cached::istrue["⚡Ready "||""]}{service.cached::isfalse["❌ Not Ready "||""]}{service.id::exists["({service.shortName}) "||""]}{stream.library::istrue["📌 Library "||""]}{stream.type::=Usenet["📰 Usenet "||""]}{stream.type::=p2p["⚠️ P2P "||""]}{stream.type::=http["💻 Web Link "||""]}{stream.type::=youtube["▶️ Youtube "||""]}{stream.type::=live["📺 Live "||""]}{stream.proxied::istrue["🔒 Proxied "||""]}{stream.private::istrue["🔑 Private "||""]}🔍{addon.name} 
{?ℹ️ {stream.message}?}
`,
  },
  tamtaro: {
    name: `{stream.resolution::exists["{stream.resolution::replace('2160p','   4K ')::replace('1440p','    2K ')::replace('p','P')}‍"||"‍     "]}{?‍{stream.type::replace('debrid','    ')::replace('p2p','⁽ᵖ²ᵖ⁾')::replace('live','⁽ˡᶦᵛᵉ⁾')::replace('http','⁽ʷᵉᵇ⁾')::replace('usenet','‍⁽ⁿᶻᵇ⁾‍')::replace('stremio-usenet','‏⁽ⁿᶻᵇ⁾')::replace('info','⁽ᶦⁿᶠᵒ⁾')::replace('statistic','⁽ˢᵗᵃᵗˢ⁾')::replace('external','⁽ᵉˣᵗ⁾')::replace('error','⁽ᵉʳʳᵒʳ⁾')::replace('youtube','⁽ʸᵗ⁾')}‍‍‍?}{service.cached["⚡"||"‍⏳‍​"||""]}{?‍‍\n  〈{stream.quality::title::replace('Bluray Remux','Remux')::replace('Web-dl','Web‍-‍dl')::replace('Hc Hd-rip','HC HDRip')::replace('Hdrip','HDRip')}〉‍     ?}{stream.message::~Download["{tools.removeLine}\n"||""]}{?‍\n  {stream.nSeScore::star::replace('⯪','☆')}            ?}{stream.message::~Download["{tools.removeLine}\n"||""]}`,
    description: `{stream.title::exists["{stream.library[\\"☁︎  {stream.title::title::truncate(15)} \\"||\\"✎  {stream.title::title::truncate(15)}\\"||\\"\\"]}"||""]}{stream.year::exists::and::stream.episodes::exists::isfalse::and::stream.seasons::exists::isfalse[" ({stream.year})"||""]}{?  {stream.seasonEpisode::join('·')::replace('E','ᴇ')::replace('S','s')::translate('0123456789','₀₁₂₃₄₅₆₇₈₉')}?}
{stream.visualTags::=IMAX["{tools.removeLine}\n"||"{tools.removeLine}\n"]}{?▣  {stream.encode}  ?}{stream.visualTags::exists::and::stream.visualTags::=IMAX::isfalse["{stream.visualTags::in('DV','HDR','HDR10','HDR10+')[\\"✦  \\"||\\"✧  \\"]}{stream.visualTags::sort::join(' · ')::replace('HDR · HDR','HDR')::replace(' · IMAX','')} "||""]}
{?♬  {stream.audioTags::lsort::join(' · ')::replace('DD · DD','DD')::replace('DTS · DTS','DTS')}  ?}{?♯  {stream.audioChannels::join(' · ')} ?}
{stream.size::>0["{stream.seasonPack[\\"❖  \\"||\\"◈  \\"||\\"\\"]}"||""]}{stream.size::>0["{stream.size::sbytes}"||""]}{stream.folderSize::>0["/{stream.folderSize::sbytes}"||""]}{? · {stream.bitrate::sbitrate::replace('Mbps','ᴹᵇᵖˢ')::replace('Kbps','ᴷᵇᵖˢ')} ?}{stream.message::~Download["{tools.removeLine}"||""]}{service.cached::isfalse::or::stream.type::=p2p::and::stream.seeders::>0["⇄ {stream.seeders}❦ "||""]}{?· {stream.age}?}
{stream.proxied::istrue["⛊  "||"⛉  "]}{?[{service.shortName}] ?}{addon.name}{stream.private::istrue[" ⚿ ᴘʀɪᴠᴀᴛᴇ "||""]}{? · {stream.releaseGroup::truncate(13)}?}{stream.indexer::exists::and::stream.type::~usenet[" · {stream.indexer::truncate(13)}"||""]}{stream.message::~Download["{tools.removeLine}\n"||""]}
{stream.uLanguages::exists["⛿  {stream.uSmallLanguageCodes::join(' · ')::replace('ꜰ','ғ')::replace('x','х')::replace('ꞯ','ϙ')::replace('ꜱ','s')::replace('ᴅᴜᴀʟ ᴀᴜᴅɪᴏ','ᴅᴜᴏ')::replace('ᴅᴜʙʙᴇᴅ','ᴅᴜʙ')}  "||""]}{stream.subbed::istrue["{stream.uLanguages::exists[\\"· sᴜʙ \\"||\\"⛿  sᴜʙ \\"]}"||""]}{stream.uSubtitles::exists["({stream.uSmallSubtitleCodes::join(' · ')::replace('ꜰ','ғ')::replace('x','х')::replace('ꞯ','ϙ')::replace('ꜱ','s')})  "||""]}{stream.seadex::or::stream.seScore::>0::or::stream.seScore::<0::or::stream.message::exists::or::stream.rseMatched::length::>0[" »  "||""]}{stream.seadexBest::istrue[" ʙᴇsᴛ ʀᴇʟᴇᴀsᴇ "||""]}{stream.seadex::istrue::and::stream.seadexBest::isfalse[" ᴀʟᴛ ʙᴇsᴛ ʀᴇʟᴇᴀsᴇ "||""]}{stream.seadex::isfalse::and::stream.rseMatched::length::>0["{stream.rseMatched::remove('TrueHD ATMOS','DD+ ATMOS','ATMOS','TrueHD','DTS-HD MA','FLAC','DTS-HD HRA','DD+','DD','DTS-ES','DTS X','DTS','AAC','Opus','DV (Disk)','DV','HDR10+ Boost','HDR','UHD Streaming Boost','HD Streaming Boost','INTERNAL','No-RlsGroup','FHD','UHD','HD','4K','126811','SiC','FraMeSToR','TheFarm','hallowed','BHDStudio','FLUX','Season Pack')::join('  ')::replace('UHD ','')::replace('HD ','')::replace('Movies Anywhere','MA')::upper::replace('F','ғ')::replace('X','х')::replace('Q','ϙ')::translate('0123456789','₀₁₂₃₄₅₆₇₈₉')::smallcaps::replace('ꜱ','s')} "||""]}{stream.message::exists[\" {stream.message::replace('NZB Health: ✅','✅ ɴᴢʙ')::replace('NZB Health: 🧝','🧝 ɴᴢʙ')::replace('AvailNZB 💚','💚 ɴᴢʙ')::replace('NZB Health: ⚠️','ᴜɴᴠᴇʀɪғɪᴇᴅ ɴᴢʙ')::replace('NZB Health: 🚫','✘ɴᴢʙ')::smallcaps} \"||\"\"]}{stream.seScore::>0::or::stream.seScore::<0["{stream.seScore::string::translate('0123456789','₀₁₂₃₄₅₆₇₈₉')}"||""]}{stream.message::~Download["{tools.removeLine}"||""]}{service.cached::istrue::and::stream.message::~Download::istrue["\n➥ DL Stream"||""]}`,
  },
};
