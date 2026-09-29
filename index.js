const crypto = require("node:crypto");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { DateTime } = require("luxon");

const PSG_EMOJI = "<:psg:1389999731941310526>";
const PSG_LOGO_URL = "https://cdn.discordapp.com/emojis/1389999731941310526.webp?size=128&quality=lossless";
const PARIS_TZ = "Europe/Paris";
const MAX_PLAYER_PICKS = 3;
const POINTS = { outcome: 2, exactScore: 5, scorer: 3, assist: 3 };

// Effectif masculin officiel PSG 2026-2027 : 24 joueurs.
const PSG_SQUAD = [
  { name: "Achraf Hakimi", number: 2 },
  { name: "Lucas Beraldo", number: 4 },
  { name: "Marquinhos", number: 5 },
  { name: "Illia Zabarnyi", number: 6 },
  { name: "Khvicha Kvaratskhelia", number: 7 },
  { name: "Fabián Ruiz", number: 8 },
  { name: "Ferran", number: 9 },
  { name: "Ousmane Dembélé", number: 10 },
  { name: "Maghnes Akliouche", number: 11 },
  { name: "Lucas Digne", number: 12 },
  { name: "Désiré Doué", number: 14 },
  { name: "Alessandro Longoni", number: 16 },
  { name: "Vitinha", number: 17 },
  { name: "Lucas Hernández", number: 21 },
  { name: "Mika Godts", number: 22 },
  { name: "Senny Mayulu", number: 24 },
  { name: "Nuno Mendes", number: 25 },
  { name: "Dro Fernández", number: 27 },
  { name: "Lucas Chevalier", number: 30 },
  { name: "Warren Zaïre-Emery", number: 33 },
  { name: "Matvey Safonov", number: 39 },
  { name: "Quentin Ndjantou", number: 47 },
  { name: "Willian Pacho", number: 51 },
  { name: "João Neves", number: 87 },
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Les données sont gardées en mémoire et disparaissent au redémarrage du bot.
const matches = new Map();
const predictions = new Map();
const sessions = new Map();
let leaderboardMessage = null;

if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN manquant.");
if (!process.env.DISCORD_CLIENT_ID) throw new Error("DISCORD_CLIENT_ID manquant.");
if (!process.env.DISCORD_GUILD_ID) throw new Error("DISCORD_GUILD_ID manquant.");

function isAdmin(interaction) {
  if (interaction.memberPermissions?.has("ManageGuild")) return true;

  const roleIds = (process.env.ADMIN_ROLE_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return roleIds.some((id) => interaction.member?.roles?.cache?.has(id));
}

function parseParisDate(value) {
  const parsed = DateTime.fromFormat(value.trim(), "dd/MM/yyyy HH:mm", {
    zone: PARIS_TZ,
    setZone: true,
    locale: "fr",
  });

  if (!parsed.isValid) {
    throw new Error(
      `Date invalide : ${value}. Format attendu : JJ/MM/AAAA HH:mm (heure de Paris).`
    );
  }

  return parsed;
}

function parseScore(value) {
  const match = value.trim().match(/^(\d{1,2})\s*[-–:]\s*(\d{1,2})$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

function outcomeLabel(outcome) {
  return {
    win: "Victoire du PSG",
    draw: "Match nul",
    loss: "Défaite du PSG",
  }[outcome];
}

function cleanName(value) {
  return value.trim().toLocaleLowerCase("fr");
}

function parseActualNames(value) {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (
    names.length === 1 &&
    ["aucun", "aucune", "none", "-", "—"].includes(cleanName(names[0]))
  ) {
    return [];
  }

  return names;
}

function getActualOutcome(homeGoals, awayGoals, homeTeam, awayTeam) {
  const isPsg = (team) => /psg|paris saint[- ]germain|paris sg/i.test(team);
  const homeIsPsg = isPsg(homeTeam);
  const awayIsPsg = isPsg(awayTeam);

  if (homeIsPsg === awayIsPsg) {
    throw new Error(
      "Ajoute « PSG » ou « Paris Saint-Germain » au nom de l’équipe du PSG."
    );
  }

  const psgGoals = homeIsPsg ? homeGoals : awayGoals;
  const otherGoals = homeIsPsg ? awayGoals : homeGoals;

  return psgGoals > otherGoals ? "win" : psgGoals < otherGoals ? "loss" : "draw";
}

function squadMenuOptions() {
  return [
    ...PSG_SQUAD.map((player, index) => ({
      label: `#${player.number} ${player.name}`,
      value: String(index),
    })),
    { label: "Aucun buteur / passeur du PSG", value: "none" },
  ];
}

function playerMenu(matchId, type) {
  const label =
    type === "scorers"
      ? "Choisis jusqu’à 3 buteurs du PSG"
      : "Choisis jusqu’à 3 passeurs du PSG";

  return new StringSelectMenuBuilder()
    .setCustomId(`psg:${type}:${matchId}`)
    .setPlaceholder(label)
    .setMinValues(1)
    .setMaxValues(MAX_PLAYER_PICKS)
    .addOptions(squadMenuOptions());
}

function menuRow(menu) {
  return new ActionRowBuilder().addComponents(menu);
}

function matchEmbed(match) {
  const kickoff = DateTime.fromMillis(match.kickoffAt, { zone: PARIS_TZ });
  const closes = DateTime.fromMillis(match.closesAt, { zone: PARIS_TZ });

  return new EmbedBuilder()
    .setColor(0x004170)
    .setTitle(`🔴🔵 ${match.homeTeam} vs ${match.awayTeam} 🔵🔴`)
    .setDescription(
      `${PSG_EMOJI} **À toi de jouer, supporter parisien !**\n` +
        "Pronostique le match et grimpe au **classement général**. 🏆\n\n" +
        `⏱️ **Coup d’envoi :** ${kickoff.toFormat("cccc d LLLL · HH:mm", {
          locale: "fr",
        })}\n` +
        `🔒 **Clôture des pronostics :** ${closes.toFormat(
          "cccc d LLLL · HH:mm",
          { locale: "fr" }
        )}\n\n` +
        "Les meilleurs seront récompensés ! 🎁"
    )
    .addFields({
      name: "🎯 Barème",
      value:
        `✅ Bon résultat : **+${POINTS.outcome} pts**\n` +
        `🎯 Score exact : **+${POINTS.exactScore} pts**\n` +
        `⚽ Buteur(s) du PSG : **+${POINTS.scorer} pts**\n` +
        `🅰️ Passeur(s) du PSG : **+${POINTS.assist} pts**`,
    })
    .setThumbnail(PSG_LOGO_URL)
    .setFooter({ text: "ALLEZ PARIS • Pronostics supporters" });
}

function matchButtons(matchId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`psg:open:${matchId}`)
      .setLabel("Faire mon pronostic")
      .setEmoji("⚽")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`psg:view:${matchId}`)
      .setLabel("Voir mon pronostic")
      .setEmoji("👀")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function logStaff(message) {
  if (!process.env.STATS_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(process.env.STATS_CHANNEL_ID);
    if (channel?.isTextBased()) await channel.send({ content: message });
  } catch (error) {
    console.error("Erreur dans le salon de stats :", error.message);
  }
}

async function setupMatch(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      content: "Commande réservée au staff.",
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const homeTeam = interaction.options.getString("equipe_domicile").trim();
    const awayTeam = interaction.options.getString("equipe_exterieure").trim();
    const kickoff = parseParisDate(interaction.options.getString("coup_denvoi"));
    const closes = parseParisDate(interaction.options.getString("cloture"));

    if (homeTeam.toLocaleLowerCase("fr") === awayTeam.toLocaleLowerCase("fr")) {
      throw new Error("Les équipes doivent être différentes.");
    }
    if (closes <= DateTime.now().setZone(PARIS_TZ)) {
      throw new Error("La clôture doit être dans le futur.");
    }
    if (closes > kickoff) {
      throw new Error("La clôture doit être avant le coup d’envoi.");
    }

    const channelId =
      interaction.options.getChannel("salon")?.id ||
      process.env.PREDICTIONS_CHANNEL_ID;

    if (!channelId) {
      throw new Error(
        "Choisis le salon dans la commande ou configure PREDICTIONS_CHANNEL_ID."
      );
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error("Le salon sélectionné n’est pas un salon texte.");
    }

    const id = `PSG-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const match = {
      id,
      homeTeam,
      awayTeam,
      kickoffAt: kickoff.toMillis(),
      closesAt: closes.toMillis(),
      channelId,
      messageId: null,
      status: "open",
      resultHome: null,
      resultAway: null,
      actualScorers: [],
      actualAssisters: [],
    };

    matches.set(id, match);
    predictions.set(id, new Map());

    const message = await channel.send({
      embeds: [matchEmbed(match)],
      components: [matchButtons(id)],
    });

    match.messageId = message.id;

    await logStaff(
      `🆕 Match prêt · ID \`${id}\` · **${homeTeam} vs ${awayTeam}** · ` +
        `Clôture ${closes.toFormat("dd/MM/yyyy HH:mm")} (Paris) · <#${channelId}>`
    );

    return interaction.editReply(
      `✅ Pronostics lancés dans <#${channelId}>. ID staff pour /match-result : \`${id}\``
    );
  } catch (error) {
    return interaction.editReply(
      error.message || "Impossible de créer le match."
    );
  }
}

function sessionKey(matchId, userId) {
  return `${matchId}:${userId}`;
}

function getSession(interaction, matchId) {
  const session = sessions.get(sessionKey(matchId, interaction.user.id));
  if (!session) {
    throw new Error(
      "Cette étape a expiré. Clique à nouveau sur « Faire mon pronostic »."
    );
  }
  return session;
}

function startPredictionPayload(match, userId) {
  sessions.set(sessionKey(match.id, userId), {
    outcome: null,
    scoreHome: null,
    scoreAway: null,
    scorers: null,
    assisters: null,
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`psg:outcome:${match.id}`)
    .setPlaceholder("Quel sera le résultat du PSG ?")
    .addOptions(
      { label: "Victoire du PSG", value: "win", emoji: "🔴" },
      { label: "Match nul", value: "draw", emoji: "🤝" },
      { label: "Défaite du PSG", value: "loss", emoji: "🔵" }
    );

  return {
    content: `**${match.homeTeam} vs ${match.awayTeam}**\n\n**1/4 · Résultat**\nQui l’emporte ?`,
    components: [menuRow(menu)],
  };
}

function scoreModal(matchId) {
  return new ModalBuilder()
    .setCustomId(`psg:score:${matchId}`)
    .setTitle("Ton score exact")
    .addComponents(
      menuRow(
        new TextInputBuilder()
          .setCustomId("score")
          .setLabel("Score domicile-extérieur, ex. 2-1")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("2-1")
          .setRequired(true)
          .setMaxLength(5)
      )
    );
}

function displayPlayers(players) {
  if (!players?.length) return "Aucun buteur du PSG";
  return players
    .map((index) =>
      index === "none" ? "Aucun" : PSG_SQUAD[Number(index)]?.name
    )
    .filter(Boolean)
    .join(", ");
}

function recapPayload(match, session) {
  const editMenu = new StringSelectMenuBuilder()
    .setCustomId(`psg:edit-field:${match.id}`)
    .setPlaceholder("✏️ Modifier une réponse avant validation")
    .addOptions(
      { label: "Modifier le résultat", value: "outcome", emoji: "🎯" },
      { label: "Modifier le score exact", value: "score", emoji: "🔢" },
      { label: "Modifier les buteurs", value: "scorers", emoji: "⚽" },
      { label: "Modifier les passeurs", value: "assisters", emoji: "🅰️" }
    );

  return {
    content:
      `**${PSG_EMOJI} Récapitulatif · ${match.homeTeam} vs ${match.awayTeam}**\n\n` +
      `🎯 Résultat : **${outcomeLabel(session.outcome)}**\n` +
      `🔢 Score : **${session.scoreHome}-${session.scoreAway}**\n` +
      `⚽ Buteur(s) PSG : **${displayPlayers(session.scorers)}**\n` +
      `🅰️ Passeur(s) PSG : **${displayPlayers(session.assisters)}**\n\n` +
      "Vérifie tes réponses. Tu peux modifier un élément ci-dessous, puis valider. " +
      "**Après validation, ton prono ne pourra plus être changé.**",
    components: [
      menuRow(editMenu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`psg:confirm:${match.id}`)
          .setLabel("Valider mon pronostic")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success)
      ),
    ],
  };
}

async function openPrediction(interaction, matchId) {
  const match = matches.get(matchId);

  if (!match || match.status !== "open" || Date.now() >= match.closesAt) {
    return interaction.reply({
      content: "🔒 Les pronostics sont clôturés.",
      ephemeral: true,
    });
  }

  const existing = predictions.get(matchId)?.get(interaction.user.id);
  if (existing) {
    return interaction.reply({
      content:
        "✅ Tu as déjà validé ton pronostic. Il n’est plus modifiable. " +
        "Utilise **Voir mon pronostic** pour le consulter.",
      ephemeral: true,
    });
  }

  return interaction.reply({
    ...startPredictionPayload(match, interaction.user.id),
    ephemeral: true,
  });
}

function validateMulti(values) {
  if (values.includes("none") && values.length > 1) return false;
  return values.length >= 1 && values.length <= MAX_PLAYER_PICKS;
}

async function handleSelect(interaction, type, matchId) {
  const match = matches.get(matchId);
  const session = getSession(interaction, matchId);
  if (!match) throw new Error("Match introuvable.");

  if (type === "outcome") {
    session.outcome = interaction.values[0];

    if (
      session.scorers &&
      session.assisters &&
      session.scoreHome !== null
    ) {
      return interaction.update(recapPayload(match, session));
    }

    return interaction.update({
      content:
        `✅ Résultat choisi : **${outcomeLabel(session.outcome)}**\n\n` +
        "**2/4 · Score exact**",
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`psg:score-open:${matchId}`)
            .setLabel("Saisir le score")
            .setEmoji("🔢")
            .setStyle(ButtonStyle.Primary)
        ),
      ],
    });
  }

  if (type === "edit-field") {
    const field = interaction.values[0];

    if (field === "outcome") {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`psg:outcome:${matchId}`)
        .setPlaceholder("Choisis le résultat")
        .addOptions(
          { label: "Victoire du PSG", value: "win", emoji: "🔴" },
          { label: "Match nul", value: "draw", emoji: "🤝" },
          { label: "Défaite du PSG", value: "loss", emoji: "🔵" }
        );

      return interaction.update({
        content: "✏️ Modifie ton résultat :",
        components: [menuRow(menu)],
      });
    }

    if (field === "score") {
      return interaction.showModal(scoreModal(matchId));
    }

    if (field === "scorers" || field === "assisters") {
      const menu = playerMenu(matchId, field);

      return interaction.update({
        content:
          field === "scorers"
            ? "✏️ Modifie tes buteurs (1 à 3 choix) :"
            : "✏️ Modifie tes passeurs (1 à 3 choix) :",
        components: [menuRow(menu)],
      });
    }
  }

  if (type === "scorers" || type === "assisters") {
    if (!validateMulti(interaction.values)) {
      return interaction.update({
        content: "Choisis « Aucun » seul, ou sélectionne de 1 à 3 joueurs. Réessaie :",
        components: [menuRow(playerMenu(matchId, type))],
      });
    }

    session[type] = interaction.values;

    if (type === "scorers") {
      if (session.assisters) {
        return interaction.update(recapPayload(match, session));
      }

      return interaction.update({
        content:
          "**4/4 · Passeurs décisifs du PSG**\n" +
          "Choisis de 1 à 3 joueurs, ou « Aucun ».",
        components: [menuRow(playerMenu(matchId, "assisters"))],
      });
    }

    return interaction.update(recapPayload(match, session));
  }
}

async function scoreSubmitted(interaction, matchId) {
  const session = getSession(interaction, matchId);
  const score = parseScore(interaction.fields.getTextInputValue("score"));

  if (!score) {
    return interaction.reply({
      content: "Format incorrect. Entre le score comme `2-1`.",
      ephemeral: true,
    });
  }

  [session.scoreHome, session.scoreAway] = score;

  const match = matches.get(matchId);
  if (session.scorers && session.assisters) {
    return interaction.update(recapPayload(match, session));
  }

  return interaction.update({
    content:
      "**3/4 · Buteurs du PSG**\nChoisis de 1 à 3 joueurs, ou « Aucun ».",
    components: [menuRow(playerMenu(matchId, "scorers"))],
  });
}

async function savePrediction(interaction, matchId) {
  const match = matches.get(matchId);
  const session = getSession(interaction, matchId);

  if (!match || match.status !== "open" || Date.now() >= match.closesAt) {
    sessions.delete(sessionKey(matchId, interaction.user.id));
    return interaction.update({
      content: "🔒 La clôture est passée. Ton prono n’a pas été enregistré.",
      components: [],
    });
  }

  if (predictions.get(matchId)?.has(interaction.user.id)) {
    sessions.delete(sessionKey(matchId, interaction.user.id));
    return interaction.update({
      content:
        "Tu as déjà validé un prono pour ce match. Il ne peut plus être modifié.",
      components: [],
    });
  }

  predictions.get(matchId).set(interaction.user.id, {
    userId: interaction.user.id,
    outcome: session.outcome,
    scoreHome: session.scoreHome,
    scoreAway: session.scoreAway,
    scorers: session.scorers,
    assisters: session.assisters,
    points: 0,
  });

  sessions.delete(sessionKey(matchId, interaction.user.id));

  await interaction.update({
    content: `✅ **Pronostic validé !** Bonne chance, supporter parisien. ${PSG_EMOJI}`,
    components: [],
  });

  await logStaff(
    `📝 Prono validé · Match \`${matchId}\` · <@${interaction.user.id}> · ` +
      `${outcomeLabel(session.outcome)} · ${session.scoreHome}-${session.scoreAway} · ` +
      `Buteurs : ${displayPlayers(session.scorers)} · Passeurs : ${displayPlayers(session.assisters)}`
  );
}

async function viewPrediction(interaction, matchId) {
  const match = matches.get(matchId);
  const pick = predictions.get(matchId)?.get(interaction.user.id);

  if (!match || !pick) {
    return interaction.reply({
      content: "Tu n’as pas encore validé de pronostic pour ce match.",
      ephemeral: true,
    });
  }

  return interaction.reply({
    content:
      `**${PSG_EMOJI} Ton pronostic · ${match.homeTeam} vs ${match.awayTeam}**\n\n` +
      `🎯 Résultat : **${outcomeLabel(pick.outcome)}**\n` +
      `🔢 Score : **${pick.scoreHome}-${pick.scoreAway}**\n` +
      `⚽ Buteur(s) : **${displayPlayers(pick.scorers)}**\n` +
      `🅰️ Passeur(s) : **${displayPlayers(pick.assisters)}**\n\n` +
      (match.status === "settled"
        ? `🏆 Points gagnés : **${pick.points} pts**`
        : "🔒 Prono validé et verrouillé."),
    ephemeral: true,
  });
}

function leaderboardRows() {
  const table = new Map();

  for (const [matchId, matchPicks] of predictions) {
    if (matches.get(matchId)?.status !== "settled") continue;

    for (const pick of matchPicks.values()) {
      const row = table.get(pick.userId) || {
        userId: pick.userId,
        points: 0,
        matches: 0,
      };
      row.points += pick.points;
      row.matches += 1;
      table.set(pick.userId, row);
    }
  }

  return [...table.values()].sort(
    (a, b) =>
      b.points - a.points ||
      b.matches - a.matches ||
      a.userId.localeCompare(b.userId)
  );
}

function leaderboardEmbed() {
  const rows = leaderboardRows();
  const description = rows.length
    ? rows
        .slice(0, 10)
        .map(
          (row, index) =>
            `**${index + 1}.** <@${row.userId}>　🏆 **${row.points} pts**`
        )
        .join("\n")
    : "Le classement apparaîtra après le premier match réglé.";

  return new EmbedBuilder()
    .setColor(0x004170)
    .setTitle(`${PSG_EMOJI} CLASSEMENT GÉNÉRAL`)
    .setDescription(
      `${description}\n\n🎁 **Les meilleurs seront récompensés !**`
    )
    .setThumbnail(PSG_LOGO_URL)
    .setFooter({ text: "Top 10 • Appuie pour voir ta position" })
    .setTimestamp();
}

async function updateLeaderboard(interaction) {
  if (
    !process.env.ADMIN_USER_ID ||
    interaction.user.id !== process.env.ADMIN_USER_ID
  ) {
    return interaction.reply({
      content: "Cette commande est réservée à l’administrateur du classement.",
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.channel;
  if (!channel?.isTextBased()) {
    return interaction.editReply("Utilise `/classement` dans un salon texte.");
  }

  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("psg:rank:me")
        .setLabel("Voir ma position")
        .setEmoji("📍")
        .setStyle(ButtonStyle.Primary)
    ),
  ];

  try {
    if (leaderboardMessage?.channelId === channel.id) {
      const oldMessage = await channel.messages
        .fetch(leaderboardMessage.id)
        .catch(() => null);

      if (oldMessage) {
        await oldMessage.edit({ embeds: [leaderboardEmbed()], components });
      } else {
        const sent = await channel.send({
          embeds: [leaderboardEmbed()],
          components,
        });
        leaderboardMessage = { channelId: channel.id, id: sent.id };
      }
    } else {
      const sent = await channel.send({
        embeds: [leaderboardEmbed()],
        components,
      });
      leaderboardMessage = { channelId: channel.id, id: sent.id };
    }

    return interaction.editReply(
      "✅ Classement général publié / actualisé dans ce salon."
    );
  } catch (error) {
    console.error(error);
    return interaction.editReply(
      "Je n’ai pas pu publier le classement. Vérifie mes permissions dans ce salon."
    );
  }
}

async function showMyRank(interaction) {
  const rows = leaderboardRows();
  const index = rows.findIndex((row) => row.userId === interaction.user.id);

  if (index < 0) {
    return interaction.reply({
      content:
        "Tu n’as pas encore de points au classement. Tes points apparaîtront après un match terminé.",
      ephemeral: true,
    });
  }

  const row = rows[index];
  const tenth = rows[9];
  const gap = index >= 10 && tenth ? Math.max(0, tenth.points - row.points) : 0;
  const positionText =
    index < 10
      ? `Tu es **${index + 1}${index === 0 ? "er" : "e"}** avec **${row.points} points**. Tu es dans le top 10 ! 🔥`
      : `Tu es **${index + 1}e** avec **${row.points} points**. Il te manque **${gap} point(s)** pour rejoindre le top 10. 💪`;

  return interaction.reply({
    content: `📍 **Ta position au classement général**\n${positionText}`,
    ephemeral: true,
  });
}

async function settleMatch(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      content: "Commande réservée au staff.",
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const matchId = interaction.options.getString("match_id").trim().toUpperCase();
  const match = matches.get(matchId);

  if (!match) {
    return interaction.editReply(
      `Match \`${matchId}\` introuvable. Vérifie l’ID dans le salon de stats.`
    );
  }
  if (match.status === "settled") {
    return interaction.editReply("Ce match a déjà été réglé.");
  }

  const score = parseScore(interaction.options.getString("score"));
  if (!score) {
    return interaction.editReply(
      "Score invalide. Format attendu : `2-1` (domicile-extérieur)."
    );
  }

  try {
    const [homeGoals, awayGoals] = score;
    const result = getActualOutcome(
      homeGoals,
      awayGoals,
      match.homeTeam,
      match.awayTeam
    );
    const actualScorers = parseActualNames(
      interaction.options.getString("buteurs_psg")
    );
    const actualAssisters = parseActualNames(
      interaction.options.getString("passeurs_psg")
    );
    const picks = predictions.get(matchId) || new Map();

    for (const pick of picks.values()) {
      let points = pick.outcome === result ? POINTS.outcome : 0;

      if (pick.scoreHome === homeGoals && pick.scoreAway === awayGoals) {
        points += POINTS.exactScore;
      }

      const gotScorer = pick.scorers.includes("none")
        ? actualScorers.length === 0
        : pick.scorers.some((value) =>
            actualScorers.some(
              (name) =>
                cleanName(name) ===
                cleanName(PSG_SQUAD[Number(value)]?.name || "")
            )
          );

      const gotAssister = pick.assisters.includes("none")
        ? actualAssisters.length === 0
        : pick.assisters.some((value) =>
            actualAssisters.some(
              (name) =>
                cleanName(name) ===
                cleanName(PSG_SQUAD[Number(value)]?.name || "")
            )
          );

      if (gotScorer) points += POINTS.scorer;
      if (gotAssister) points += POINTS.assist;
      pick.points = points;
    }

    match.status = "settled";
    match.resultHome = homeGoals;
    match.resultAway = awayGoals;
    match.actualScorers = actualScorers;
    match.actualAssisters = actualAssisters;

    await interaction.editReply(
      `✅ Résultat saisi pour **${match.homeTeam} ${homeGoals}-${awayGoals} ${match.awayTeam}**. ` +
        `${picks.size} pronostic(s) noté(s). Lance \`/classement\` quand tu veux actualiser le classement public.`
    );

    await logStaff(
      `🏁 Résultat · ID \`${matchId}\` · **${match.homeTeam} ${homeGoals}-${awayGoals} ${match.awayTeam}** · ` +
        `Buteurs PSG : ${actualScorers.join(", ") || "aucun"} · ` +
        `Passeurs PSG : ${actualAssisters.join(", ") || "aucun"}`
    );
  } catch (error) {
    console.error(error);
    return interaction.editReply(
      error.message || "Erreur lors du calcul des points."
    );
  }
}

async function cancelMatch(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({
      content: "Commande réservée au staff.",
      ephemeral: true,
    });
  }

  const matchId = interaction.options.getString("match_id").trim().toUpperCase();
  const match = matches.get(matchId);

  if (!match || !["open", "closed"].includes(match.status)) {
    return interaction.reply({
      content: "Match introuvable ou déjà réglé.",
      ephemeral: true,
    });
  }

  match.status = "cancelled";

  const channel = await client.channels.fetch(match.channelId).catch(() => null);
  const message = channel?.isTextBased()
    ? await channel.messages.fetch(match.messageId).catch(() => null)
    : null;

  if (message) {
    const cancelled = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("psg:cancelled")
        .setLabel("Match annulé")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );

    await message
      .edit({
        embeds: [
          EmbedBuilder.from(message.embeds[0]).setFooter({
            text: "Match annulé",
          }),
        ],
        components: [cancelled],
      })
      .catch(() => {});
  }

  await logStaff(
    `🚫 Match annulé · ID \`${matchId}\` · ${match.homeTeam} vs ${match.awayTeam}`
  );

  return interaction.reply({
    content: `Match \`${matchId}\` annulé.`,
    ephemeral: true,
  });
}

async function closeExpiredMatches() {
  for (const match of matches.values()) {
    if (match.status !== "open" || Date.now() < match.closesAt) continue;

    match.status = "closed";

    const channel = await client.channels.fetch(match.channelId).catch(() => null);
    const message = channel?.isTextBased()
      ? await channel.messages.fetch(match.messageId).catch(() => null)
      : null;

    if (message) {
      const closed = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("psg:closed")
          .setLabel("Pronostics clôturés")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`psg:view:${match.id}`)
          .setLabel("Voir mon pronostic")
          .setEmoji("👀")
          .setStyle(ButtonStyle.Secondary)
      );

      await message
        .edit({
          embeds: [
            EmbedBuilder.from(message.embeds[0]).setFooter({
              text: "🔒 Pronostics clôturés",
            }),
          ],
          components: [closed],
        })
        .catch((error) =>
          console.error("Fermeture du message impossible :", error.message)
        );
    }

    await logStaff(
      `🔒 Pronostics clôturés · ID \`${match.id}\` · ${match.homeTeam} vs ${match.awayTeam}`
    );
  }
}

function commands() {
  return [
    new SlashCommandBuilder()
      .setName("match-setup")
      .setDescription("Créer le post pronostics d’un match")
      .addStringOption((o) =>
        o
          .setName("equipe_domicile")
          .setDescription("Ex. PSG")
          .setRequired(true)
          .setMaxLength(80)
      )
      .addStringOption((o) =>
        o
          .setName("equipe_exterieure")
          .setDescription("Ex. Lyon")
          .setRequired(true)
          .setMaxLength(80)
      )
      .addStringOption((o) =>
        o
          .setName("coup_denvoi")
          .setDescription("Heure de Paris : JJ/MM/AAAA HH:mm")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("cloture")
          .setDescription("Heure de Paris : JJ/MM/AAAA HH:mm")
          .setRequired(true)
      )
      .addChannelOption((o) =>
        o
          .setName("salon")
          .setDescription("Salon des pronostics")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("match-result")
      .setDescription("Saisir le score officiel et attribuer les points")
      .addStringOption((o) =>
        o
          .setName("match_id")
          .setDescription("ID reçu dans le salon de stats")
          .setRequired(true)
          .setMaxLength(20)
      )
      .addStringOption((o) =>
        o
          .setName("score")
          .setDescription("Score domicile-extérieur, ex. 2-1")
          .setRequired(true)
          .setMaxLength(10)
      )
      .addStringOption((o) =>
        o
          .setName("buteurs_psg")
          .setDescription("Buteurs PSG, séparés par des virgules; aucun si aucun")
          .setRequired(true)
          .setMaxLength(1000)
      )
      .addStringOption((o) =>
        o
          .setName("passeurs_psg")
          .setDescription(
            "Passeurs PSG, séparés par des virgules; aucun si aucun"
          )
          .setRequired(true)
          .setMaxLength(1000)
      ),

    new SlashCommandBuilder()
      .setName("classement")
      .setDescription("Publier ou actualiser le top 10 (admin uniquement)"),

    new SlashCommandBuilder()
      .setName("mes-pronos")
      .setDescription("Voir tes pronostics validés"),

    new SlashCommandBuilder()
      .setName("match-cancel")
      .setDescription("Annuler un match créé par erreur")
      .addStringOption((o) =>
        o
          .setName("match_id")
          .setDescription("ID du match")
          .setRequired(true)
          .setMaxLength(20)
      ),
  ].map((command) => command.toJSON());
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_CLIENT_ID,
      process.env.DISCORD_GUILD_ID
    ),
    { body: commands() }
  );

  console.log("Commandes Discord synchronisées.");
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "match-setup") {
        return setupMatch(interaction);
      }
      if (interaction.commandName === "match-result") {
        return settleMatch(interaction);
      }
      if (interaction.commandName === "classement") {
        return updateLeaderboard(interaction);
      }
      if (interaction.commandName === "match-cancel") {
        return cancelMatch(interaction);
      }

      if (interaction.commandName === "mes-pronos") {
        const lines = [];

        for (const [matchId, picks] of predictions) {
          const pick = picks.get(interaction.user.id);
          const match = matches.get(matchId);
          if (!pick || !match) continue;

          lines.push(
            `**${match.homeTeam} vs ${match.awayTeam}**\n` +
              `${outcomeLabel(pick.outcome)} · ${pick.scoreHome}-${pick.scoreAway}\n` +
              `⚽ ${displayPlayers(pick.scorers)} · 🅰️ ${displayPlayers(pick.assisters)}\n` +
              `${match.status === "settled" ? `🏆 ${pick.points} pts` : "🔒 Validé"}`
          );
        }

        return interaction.reply({
          content:
            lines.join("\n\n").slice(0, 1900) ||
            "Tu n’as pas encore validé de pronostic.",
          ephemeral: true,
        });
      }
    }

    if (interaction.isButton()) {
      const [, action, ...parts] = interaction.customId.split(":");
      const value = parts.join(":");

      if (action === "open") return openPrediction(interaction, value);
      if (action === "view") return viewPrediction(interaction, value);
      if (action === "score-open") {
        return interaction.showModal(scoreModal(value));
      }
      if (action === "confirm") return savePrediction(interaction, value);
      if (action === "rank") return showMyRank(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      const [, type, ...parts] = interaction.customId.split(":");
      return handleSelect(interaction, type, parts.join(":"));
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("psg:score:")
    ) {
      return scoreSubmitted(
        interaction,
        interaction.customId.slice("psg:score:".length)
      );
    }
  } catch (error) {
    console.error(error);
    const response = {
      content: error.message || "Une erreur est survenue. Réessaie.",
      ephemeral: true,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(response).catch(() => {});
    } else {
      await interaction.reply(response).catch(() => {});
    }
  }
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Connecté en tant que ${readyClient.user.tag}`);

  await registerCommands();
  await closeExpiredMatches().catch(console.error);
  setInterval(() => closeExpiredMatches().catch(console.error), 15_000);
});

client.on(Events.Error, (error) => console.error("Erreur Discord :", error));

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error("Connexion Discord impossible :", error);
  process.exit(1);
});
