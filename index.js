require("dotenv").config();

const crypto = require("node:crypto");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  time,
} = require("discord.js");
const { DateTime } = require("luxon");
const { Pool } = require("pg");

const TZ = process.env.TIMEZONE || "Europe/Paris";
const POINTS = {
  outcome: Number(process.env.POINTS_RESULT || 2),
  score: Number(process.env.POINTS_EXACT_SCORE || 5),
  scorer: Number(process.env.POINTS_SCORER || 3),
  assist: Number(process.env.POINTS_ASSIST || 3),
};

if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN manquant.");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL manquant. Ajoute PostgreSQL au projet Railway.");

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const sessions = new Map();

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS matches (
      match_id TEXT PRIMARY KEY,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      kickoff_at TIMESTAMPTZ NOT NULL,
      closes_at TIMESTAMPTZ NOT NULL,
      image_url TEXT,
      scorers TEXT[] NOT NULL DEFAULT '{}',
      assisters TEXT[] NOT NULL DEFAULT '{}',
      channel_id TEXT NOT NULL,
      message_id TEXT,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'closed', 'settled', 'cancelled')),
      result_home INTEGER,
      result_away INTEGER,
      actual_scorers TEXT[] NOT NULL DEFAULT '{}',
      actual_assisters TEXT[] NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS picks (
      match_id TEXT NOT NULL REFERENCES matches(match_id),
      user_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('win', 'draw', 'loss')),
      score_home INTEGER NOT NULL,
      score_away INTEGER NOT NULL,
      scorer TEXT NOT NULL,
      assister TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (match_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS picks_user_idx ON picks(user_id);
    CREATE INDEX IF NOT EXISTS matches_status_close_idx
      ON matches(status, closes_at);
  `);
}

function parseParisDate(value) {
  const parsed = DateTime.fromFormat(value.trim(), "dd/MM/yyyy HH:mm", {
    zone: TZ,
    setZone: true,
    locale: "fr",
  });
  if (!parsed.isValid) {
    throw new Error(`Date invalide : "${value}". Format attendu : JJ/MM/AAAA HH:mm, heure de Paris.`);
  }
  return parsed;
}

function parseScore(value) {
  const match = value.trim().match(/^(\d{1,2})\s*[-–:]\s*(\d{1,2})$/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function splitNames(value) {
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.length) throw new Error("Indique au moins un nom.");
  if (names.some((name) => name.length > 80)) {
    throw new Error("Chaque nom doit faire 80 caractères maximum.");
  }
  return names;
}

function addNoChoice(names) {
  const hasNone = names.some((name) =>
    ["aucun", "aucune", "none", "—", "-"].includes(name.toLocaleLowerCase("fr"))
  );
  return hasNone ? names : [...names, "Aucun"];
}

function cleanName(value) {
  return value.trim().toLocaleLowerCase("fr");
}

function parseActualNames(value) {
  const names = splitNames(value);
  if (names.length === 1 && ["aucun", "aucune", "none", "—", "-"].includes(cleanName(names[0]))) {
    return [];
  }
  return names;
}

function isAdmin(interaction) {
  if (interaction.memberPermissions?.has("ManageGuild")) return true;

  const allowedRoles = (process.env.ADMIN_ROLE_IDS || "")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);

  return allowedRoles.some((role) => interaction.member?.roles?.cache?.has(role));
}

function outcomeLabel(outcome) {
  return {
    win: "Victoire du PSG",
    draw: "Match nul",
    loss: "Défaite du PSG",
  }[outcome];
}

function actualOutcome(homeGoals, awayGoals, homeTeam, awayTeam) {
  const psgLabel = (process.env.PSG_LABEL || "PSG").toLocaleLowerCase("fr");
  const isPsg = (team) =>
    team.toLocaleLowerCase("fr").includes(psgLabel) ||
    /paris saint[- ]germain|paris sg/i.test(team);

  const homeIsPsg = isPsg(homeTeam);
  const awayIsPsg = isPsg(awayTeam);

  if (homeIsPsg === awayIsPsg) {
    throw new Error('Impossible d’identifier le PSG. Mets « PSG » ou « Paris Saint-Germain » dans le nom de son équipe.');
  }

  const psgGoals = homeIsPsg ? homeGoals : awayGoals;
  const opponentGoals = homeIsPsg ? awayGoals : homeGoals;

  if (psgGoals > opponentGoals) return "win";
  if (psgGoals < opponentGoals) return "loss";
  return "draw";
}

function isNone(value) {
  return ["aucun", "aucune", "none", "—", "-"].includes(cleanName(value));
}

function namesOptions(names) {
  return names.slice(0, 25).map((name, index) => ({
    label: name.slice(0, 100),
    value: String(index),
  }));
}

function matchEmbed(match) {
  const embed = new EmbedBuilder()
    .setColor(0x004170)
    .setTitle(`${match.home_team} - ${match.away_team}`)
    .setDescription(
      [
        `Pronostics ouverts jusqu’au ${time(Math.floor(new Date(match.closes_at).getTime() / 1000), "F")} (heure de Paris).`,
        `Coup d’envoi : ${time(Math.floor(new Date(match.kickoff_at).getTime() / 1000), "F")}`,
        "",
        "Prédisez le résultat, le score exact, un buteur du PSG et un passeur décisif du PSG.",
        "Les pronostics restent privés jusqu’à la clôture.",
      ].join("\n")
    )
    .addFields(
      { name: "ID du match", value: `\`${match.match_id}\``, inline: true },
      {
        name: "Barème",
        value: `Résultat **+${POINTS.outcome}** · Score exact **+${POINTS.score}** · Buteur **+${POINTS.scorer}** · Passeur **+${POINTS.assist}**`,
      }
    );

  if (match.image_url) embed.setImage(match.image_url);
  return embed;
}

function startWizardPayload(match, userId) {
  sessions.set(`${match.match_id}:${userId}`, {
    match,
    outcome: null,
    scoreHome: null,
    scoreAway: null,
    scorer: null,
    assister: null,
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`psg:outcome:${match.match_id}`)
    .setPlaceholder("Choisis le résultat du PSG")
    .addOptions(
      { label: "Victoire du PSG", value: "win", emoji: "🔴" },
      { label: "Match nul", value: "draw", emoji: "🤝" },
      { label: "Défaite du PSG", value: "loss", emoji: "🔵" }
    );

  return {
    content: `**${match.home_team} - ${match.away_team}**\nÉtape 1/4 · Quel résultat prédis-tu ?`,
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

function sessionFor(interaction, matchId) {
  const session = sessions.get(`${matchId}:${interaction.user.id}`);
  if (!session) throw new Error("La session a expiré. Clique de nouveau sur « Faire mon pronostic ».");
  return session;
}

function scoreModal(matchId) {
  return new ModalBuilder()
    .setCustomId(`psg:score:${matchId}`)
    .setTitle("Score exact")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("score")
          .setLabel("Score domicile-extérieur, par exemple 2-1")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("2-1")
          .setRequired(true)
          .setMaxLength(5)
      )
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
    return interaction.reply({ content: "Commande réservée au staff.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const home = interaction.options.getString("equipe_domicile").trim();
    const away = interaction.options.getString("equipe_exterieure").trim();
    const kickoff = parseParisDate(interaction.options.getString("coup_denvoi"));
    const closes = parseParisDate(interaction.options.getString("cloture"));

    if (home.toLocaleLowerCase("fr") === away.toLocaleLowerCase("fr")) {
      throw new Error("Les deux équipes doivent être différentes.");
    }
    if (closes <= DateTime.now().setZone(TZ)) throw new Error("La clôture doit être dans le futur.");
    if (closes > kickoff) throw new Error("La clôture doit être avant le coup d’envoi.");

    const scorers = addNoChoice(splitNames(interaction.options.getString("buteurs_psg")));
    const assisters = addNoChoice(splitNames(interaction.options.getString("passeurs_psg")));
    if (scorers.length > 25 || assisters.length > 25) {
      throw new Error("Maximum 24 noms par liste. Le choix « Aucun » est ajouté automatiquement.");
    }

    const image = interaction.options.getString("image_url");
    if (image && !/^https:\/\/.+\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(image)) {
      throw new Error("L’image doit être une URL HTTPS terminant par .png, .jpg, .jpeg, .gif ou .webp.");
    }

    const channelId = interaction.options.getChannel("salon")?.id || process.env.PREDICTIONS_CHANNEL_ID;
    if (!channelId) throw new Error("Indique un salon ou configure PREDICTIONS_CHANNEL_ID.");
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error("Le salon choisi n’est pas un salon texte.");

    const matchId = `PSG-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const result = await db.query(
      `INSERT INTO matches
       (match_id,home_team,away_team,kickoff_at,closes_at,image_url,scorers,assisters,channel_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        matchId,
        home,
        away,
        kickoff.toUTC().toISO(),
        closes.toUTC().toISO(),
        image,
        scorers,
        assisters,
        channelId,
        interaction.user.id,
      ]
    );

    const match = result.rows[0];
    const message = await channel.send({
      embeds: [matchEmbed(match)],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`psg:open:${matchId}`)
            .setLabel("Faire mon pronostic")
            .setStyle(ButtonStyle.Primary)
        ),
      ],
    });

    await db.query("UPDATE matches SET message_id=$1 WHERE match_id=$2", [message.id, matchId]);
    await logStaff(
      `🆕 Match créé · ID \`${matchId}\` · **${home} - ${away}** · Clôture ${closes.toFormat("dd/MM/yyyy HH:mm")} (${TZ}) · <#${channelId}>`
    );

    return interaction.editReply(`Match créé. ID : \`${matchId}\` · Message publié dans <#${channelId}>.`);
  } catch (error) {
    return interaction.editReply(error.message || "Impossible de créer le match.");
  }
}

async function openPrediction(interaction, matchId) {
  const result = await db.query("SELECT * FROM matches WHERE match_id=$1", [matchId]);
  const match = result.rows[0];

  if (!match || match.status !== "open" || Date.now() >= new Date(match.closes_at).getTime()) {
    return interaction.reply({ content: "Les pronostics pour ce match sont clôturés ou indisponibles.", ephemeral: true });
  }

  return interaction.reply({ ...startWizardPayload(match, interaction.user.id), ephemeral: true });
}

async function handleSelect(interaction, step, matchId) {
  const session = sessionFor(interaction, matchId);

  if (step === "outcome") {
    session.outcome = interaction.values[0];
    return interaction.update({
      content: `Résultat : **${outcomeLabel(session.outcome)}**.\nÉtape 2/4 · Saisis le score exact.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`psg:score-open:${matchId}`)
            .setLabel("Saisir le score")
            .setStyle(ButtonStyle.Primary)
        ),
      ],
    });
  }

  if (step === "scorer" || step === "assister") {
    const list = step === "scorer" ? session.match.scorers : session.match.assisters;
    const selected = list[Number(interaction.values[0])];
    if (!selected) throw new Error("Choix invalide. Recommence le pronostic.");

    if (step === "scorer") {
      session.scorer = selected;
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`psg:assister:${matchId}`)
        .setPlaceholder("Choisis le passeur décisif du PSG")
        .addOptions(namesOptions(session.match.assisters));

      return interaction.update({
        content: `Étape 4/4 · Choisis le passeur décisif du PSG`,
        components: [new ActionRowBuilder().addComponents(menu)],
      });
    }

    session.assister = selected;
    return interaction.update({
      content: [
        `**Récapitulatif · ${session.match.home_team} - ${session.match.away_team}**`,
        `Résultat : **${outcomeLabel(session.outcome)}**`,
        `Score : **${session.scoreHome}-${session.scoreAway}**`,
        `Buteur PSG : **${session.scorer}**`,
        `Passeur PSG : **${session.assister}**`,
        "",
        "Confirme pour enregistrer. Tu pourras modifier ton prono avant la clôture.",
      ].join("\n"),
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`psg:confirm:${matchId}`)
            .setLabel("Confirmer mon prono")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`psg:edit:${matchId}`)
            .setLabel("Modifier mon prono")
            .setStyle(ButtonStyle.Secondary)
        ),
      ],
    });
  }
}

async function savePrediction(interaction, matchId) {
  const session = sessionFor(interaction, matchId);
  const connection = await db.connect();

  try {
    await connection.query("BEGIN");
    const matchCheck = await connection.query(
      "SELECT status,closes_at FROM matches WHERE match_id=$1 FOR UPDATE",
      [matchId]
    );

    if (
      !matchCheck.rows[0] ||
      matchCheck.rows[0].status !== "open" ||
      Date.now() >= new Date(matchCheck.rows[0].closes_at).getTime()
    ) {
      await connection.query("ROLLBACK");
      sessions.delete(`${matchId}:${interaction.user.id}`);
      return interaction.update({ content: "La clôture est passée. Ton pronostic n’a pas été enregistré.", components: [] });
    }

    await connection.query(
      `INSERT INTO picks (match_id,user_id,outcome,score_home,score_away,scorer,assister)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (match_id,user_id) DO UPDATE SET
         outcome=EXCLUDED.outcome,
         score_home=EXCLUDED.score_home,
         score_away=EXCLUDED.score_away,
         scorer=EXCLUDED.scorer,
         assister=EXCLUDED.assister,
         updated_at=NOW()`,
      [
        matchId,
        interaction.user.id,
        session.outcome,
        session.scoreHome,
        session.scoreAway,
        session.scorer,
        session.assister,
      ]
    );

    await connection.query("COMMIT");
    sessions.delete(`${matchId}:${interaction.user.id}`);

    await interaction.update({
      content: `✅ Ton pronostic pour **${session.match.home_team} - ${session.match.away_team}** est enregistré. Tu peux le modifier depuis le bouton du match avant la clôture.`,
      components: [],
    });

    await logStaff(
      `📝 Prono enregistré · Match \`${matchId}\` · <@${interaction.user.id}> · ${outcomeLabel(session.outcome)} · ${session.scoreHome}-${session.scoreAway} · Buteur : ${session.scorer} · Passeur : ${session.assister}`
    );
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function scoreSubmitted(interaction, matchId) {
  const session = sessionFor(interaction, matchId);
  const score = parseScore(interaction.fields.getTextInputValue("score"));

  if (!score) {
    return interaction.reply({ content: "Format invalide. Écris le score comme `2-1`.", ephemeral: true });
  }

  [session.scoreHome, session.scoreAway] = score;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`psg:scorer:${matchId}`)
    .setPlaceholder("Choisis un buteur du PSG")
    .addOptions(namesOptions(session.match.scorers));

  return interaction.update({
    content: "Étape 3/4 · Choisis un buteur du PSG.",
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function settleMatch(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: "Commande réservée au staff.", ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const matchId = interaction.options.getString("match_id").trim().toUpperCase();
  const score = parseScore(interaction.options.getString("score"));
  if (!score) return interaction.editReply("Score invalide. Exemple : `2-1`, dans l’ordre domicile-extérieur.");

  try {
    const actualScorers = parseActualNames(interaction.options.getString("buteurs_psg"));
    const actualAssisters = parseActualNames(interaction.options.getString("passeurs_psg"));
    const matchResult = await db.query("SELECT * FROM matches WHERE match_id=$1", [matchId]);
    const match = matchResult.rows[0];

    if (!match) return interaction.editReply(`Match \`${matchId}\` introuvable.`);
    if (match.status === "settled") return interaction.editReply(`Le match \`${matchId}\` a déjà été réglé.`);

    const [homeGoals, awayGoals] = score;
    const result = actualOutcome(homeGoals, awayGoals, match.home_team, match.away_team);
    const connection = await db.connect();
    let count = 0;

    try {
      await connection.query("BEGIN");
      const picks = await connection.query(
        "SELECT * FROM picks WHERE match_id=$1 FOR UPDATE",
        [matchId]
      );

      for (const pick of picks.rows) {
        let points = 0;
        if (pick.outcome === result) points += POINTS.outcome;
        if (pick.score_home === homeGoals && pick.score_away === awayGoals) points += POINTS.score;
        if (actualScorers.some((name) => cleanName(name) === cleanName(pick.scorer))) points += POINTS.scorer;
        if (actualAssisters.some((name) => cleanName(name) === cleanName(pick.assister))) points += POINTS.assist;

        await connection.query(
          "UPDATE picks SET points=$1 WHERE match_id=$2 AND user_id=$3",
          [points, matchId, pick.user_id]
        );
        count++;
      }

      await connection.query(
        `UPDATE matches
         SET status='settled', result_home=$1, result_away=$2,
             actual_scorers=$3, actual_assisters=$4, settled_at=NOW()
         WHERE match_id=$5`,
        [homeGoals, awayGoals, actualScorers, actualAssisters, matchId]
      );

      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      connection.release();
    }

    await interaction.editReply(
      `Résultat enregistré pour \`${matchId}\` : **${homeGoals}-${awayGoals}**. Points calculés pour ${count} prono(s).`
    );

    await logStaff(
      `🏁 Match réglé · ID \`${matchId}\` · **${match.home_team} ${homeGoals}-${awayGoals} ${match.away_team}** · Buteurs PSG : ${actualScorers.join(", ") || "aucun"} · Passeurs PSG : ${actualAssisters.join(", ") || "aucun"} · ${count} prono(s) calculés`
    );

    await postLeaderboard();
  } catch (error) {
    console.error(error);
    return interaction.editReply(error.message || "Erreur pendant le calcul des points.");
  }
}

async function leaderboardEmbed(limit = 25) {
  const result = await db.query(
    `SELECT p.user_id,
            SUM(p.points)::int AS points,
            COUNT(*)::int AS matches
     FROM picks p
     JOIN matches m USING(match_id)
     WHERE m.status='settled'
     GROUP BY p.user_id
     ORDER BY points DESC, matches DESC, p.user_id ASC
     LIMIT $1`,
    [limit]
  );

  const description = result.rows.length
    ? result.rows.map((row, index) => `**${index + 1}.** <@${row.user_id}> · **${row.points} pts** (${row.matches} matchs)`).join("\n")
    : "Aucun résultat comptabilisé pour le moment.";

  return new EmbedBuilder()
    .setColor(0x004170)
    .setTitle("Classement général · Pronostics PSG")
    .setDescription(description)
    .setTimestamp();
}

async function postLeaderboard() {
  if (!process.env.STATS_CHANNEL_ID) return;
  const channel = await client.channels.fetch(process.env.STATS_CHANNEL_ID).catch(() => null);
  if (channel?.isTextBased()) {
    await channel.send({ embeds: [await leaderboardEmbed(15)] });
  }
}

async function showLeaderboard(interaction) {
  return interaction.reply({ embeds: [await leaderboardEmbed(25)], ephemeral: false });
}

async function showMyPredictions(interaction) {
  const result = await db.query(
    `SELECT m.match_id,m.home_team,m.away_team,m.status,m.result_home,m.result_away,
            p.outcome,p.score_home,p.score_away,p.scorer,p.assister,p.points
     FROM picks p
     JOIN matches m USING(match_id)
     WHERE p.user_id=$1
     ORDER BY m.kickoff_at DESC
     LIMIT 20`,
    [interaction.user.id]
  );

  const description = result.rows.length
    ? result.rows.map((row) =>
        `**${row.home_team} - ${row.away_team}** · \`${row.match_id}\`\n` +
        `${outcomeLabel(row.outcome)} · ${row.score_home}-${row.score_away} · Buteur : ${row.scorer} · Passeur : ${row.assister}\n` +
        `${row.status === "settled" ? `Résultat ${row.result_home}-${row.result_away} · **${row.points} pts**` : "Points en attente"}`
      ).join("\n\n")
    : "Tu n’as encore aucun pronostic.";

  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x004170).setTitle("Mes pronostics").setDescription(description.slice(0, 4000))],
    ephemeral: true,
  });
}

async function cancelMatch(interaction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: "Commande réservée au staff.", ephemeral: true });
  }

  const matchId = interaction.options.getString("match_id").trim().toUpperCase();
  const result = await db.query(
    `UPDATE matches SET status='cancelled'
     WHERE match_id=$1 AND status IN ('open','closed')
     RETURNING *`,
    [matchId]
  );

  const match = result.rows[0];
  if (!match) return interaction.reply({ content: `Match \`${matchId}\` introuvable ou déjà réglé.`, ephemeral: true });

  if (match.message_id) {
    const channel = await client.channels.fetch(match.channel_id).catch(() => null);
    const message = channel?.isTextBased()
      ? await channel.messages.fetch(match.message_id).catch(() => null)
      : null;

    if (message) {
      await message.edit({
        embeds: [EmbedBuilder.from(message.embeds[0]).setColor(0x777777).setFooter({ text: "Match annulé" })],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("psg:cancelled").setLabel("Match annulé").setStyle(ButtonStyle.Secondary).setDisabled(true)
          ),
        ],
      }).catch(() => {});
    }
  }

  await logStaff(`🚫 Match annulé · ID \`${matchId}\` · ${match.home_team} - ${match.away_team}`);
  return interaction.reply({ content: `Match \`${matchId}\` annulé.`, ephemeral: true });
}

async function closeExpiredMatches() {
  const result = await db.query(
    `UPDATE matches SET status='closed'
     WHERE status='open' AND closes_at <= NOW()
     RETURNING *`
  );

  for (const match of result.rows) {
    const channel = await client.channels.fetch(match.channel_id).catch(() => null);
    const message = channel?.isTextBased()
      ? await channel.messages.fetch(match.message_id).catch(() => null)
      : null;

    if (message) {
      await message.edit({
        embeds: [EmbedBuilder.from(message.embeds[0]).setColor(0x777777).setFooter({ text: "Pronostics clôturés" })],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("psg:closed").setLabel("Pronostics clôturés").setStyle(ButtonStyle.Secondary).setDisabled(true)
          ),
        ],
      }).catch((error) => console.error("Erreur de fermeture du message :", error.message));
    }

    await logStaff(`🔒 Pronostics clôturés automatiquement · Match \`${match.match_id}\` · ${match.home_team} - ${match.away_team}`);
  }
}

function slashCommands() {
  const { SlashCommandBuilder, ChannelType } = require("discord.js");

  return [
    new SlashCommandBuilder()
      .setName("match-setup")
      .setDescription("Créer un match et ouvrir les pronostics")
      .addStringOption((option) => option.setName("equipe_domicile").setDescription("Équipe affichée en premier").setRequired(true).setMaxLength(80))
      .addStringOption((option) => option.setName("equipe_exterieure").setDescription("Équipe affichée en second").setRequired(true).setMaxLength(80))
      .addStringOption((option) => option.setName("coup_denvoi").setDescription("Heure de Paris : JJ/MM/AAAA HH:mm").setRequired(true))
      .addStringOption((option) => option.setName("cloture").setDescription("Heure de Paris : JJ/MM/AAAA HH:mm").setRequired(true))
      .addStringOption((option) => option.setName("buteurs_psg").setDescription("Noms séparés par des virgules").setRequired(true).setMaxLength(1000))
      .addStringOption((option) => option.setName("passeurs_psg").setDescription("Noms séparés par des virgules").setRequired(true).setMaxLength(1000))
      .addStringOption((option) => option.setName("image_url").setDescription("URL HTTPS d’image (facultatif)").setRequired(false).setMaxLength(500))
      .addChannelOption((option) => option.setName("salon").setDescription("Salon des pronostics").addChannelTypes(ChannelType.GuildText).setRequired(false)),

    new SlashCommandBuilder()
      .setName("match-result")
      .setDescription("Saisir le résultat et attribuer les points")
      .addStringOption((option) => option.setName("match_id").setDescription("ID du match indiqué dans le salon de stats").setRequired(true).setMaxLength(20))
      .addStringOption((option) => option.setName("score").setDescription("Score domicile-extérieur, ex. 2-1").setRequired(true).setMaxLength(10))
      .addStringOption((option) => option.setName("buteurs_psg").setDescription("Buteurs PSG réels, séparés par des virgules, ou aucun").setRequired(true).setMaxLength(1000))
      .addStringOption((option) => option.setName("passeurs_psg").setDescription("Passeurs PSG réels, séparés par des virgules, ou aucun").setRequired(true).setMaxLength(1000)),

    new SlashCommandBuilder()
      .setName("classement")
      .setDescription("Afficher le classement général"),

    new SlashCommandBuilder()
      .setName("mes-pronos")
      .setDescription("Voir tes pronostics"),

    new SlashCommandBuilder()
      .setName("match-cancel")
      .setDescription("Annuler un match créé par erreur")
      .addStringOption((option) => option.setName("match_id").setDescription("ID du match").setRequired(true).setMaxLength(20)),
  ].map((command) => command.toJSON());
}

async function registerCommands() {
  const { REST, Routes } = require("discord.js");
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_GUILD_ID) {
    throw new Error("DISCORD_CLIENT_ID et DISCORD_GUILD_ID sont obligatoires.");
  }

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
    { body: slashCommands() }
  );
  console.log("Commandes Discord synchronisées.");
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "match-setup") return setupMatch(interaction);
      if (interaction.commandName === "match-result") return settleMatch(interaction);
      if (interaction.commandName === "classement") return showLeaderboard(interaction);
      if (interaction.commandName === "mes-pronos") return showMyPredictions(interaction);
      if (interaction.commandName === "match-cancel") return cancelMatch(interaction);
    }

    if (interaction.isButton()) {
      const [, action, ...parts] = interaction.customId.split(":");
      const matchId = parts.join(":");

      if (action === "open") return openPrediction(interaction, matchId);
      if (action === "score-open") return interaction.showModal(scoreModal(matchId));
      if (action === "confirm") return savePrediction(interaction, matchId);

      if (action === "edit") {
        const result = await db.query("SELECT * FROM matches WHERE match_id=$1", [matchId]);
        const match = result.rows[0];

        if (!match || match.status !== "open" || Date.now() >= new Date(match.closes_at).getTime()) {
          return interaction.update({ content: "Les pronostics sont clôturés.", components: [] });
        }

        return interaction.update(startWizardPayload(match, interaction.user.id));
      }
    }

    if (interaction.isStringSelectMenu()) {
      const [, step, ...parts] = interaction.customId.split(":");
      return handleSelect(interaction, step, parts.join(":"));
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("psg:score:")) {
      return scoreSubmitted(interaction, interaction.customId.slice("psg:score:".length));
    }
  } catch (error) {
    console.error(error);
    const response = { content: error.message || "Une erreur est survenue. Réessaie.", ephemeral: true };

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

initDb()
  .then(() => client.login(process.env.DISCORD_TOKEN))
  .catch((error) => {
    console.error("Démarrage impossible :", error);
    process.exit(1);
  });
