/**
 * Label value definitions declared by this labeller.
 *
 * Format reference: https://docs.bsky.app/docs/advanced-guides/moderation#custom-label-values
 * These are passed to `declareLabeler` from @skyware/labeler to publish the
 * app.bsky.labeler.service record so the labels render with names/descriptions
 * in clients instead of as raw label values.
 */
import { LABEL_CURRENT, LABEL_ALUMNI, LABEL_GRANDMASTER } from "./config.js";

// The shape matches ComAtprotoLabelDefs.LabelValueDefinition.
export const LABEL_DEFINITIONS = [
	{
		identifier: LABEL_CURRENT,
		// "inform" = neutral badge, content stays visible, no blur.
		severity: "inform",
		blurs: "none",
		defaultSetting: "warn",
		// Crown moves daily; don't let stale labels linger if the labeler goes quiet.
		adultOnly: false,
		locales: [
			{
				lang: "en",
				name: "Top Chicken 🐔",
				description:
					"The reigning Top Chicken: today's most-liked post from an account under the 7,000-follower Grace Limit. The crown moves daily.",
				// nb: the label *value* (top-chicken) is fixed; only this display
				// name/description is safe to edit + re-declare.
			},
		],
	},
	{
		identifier: LABEL_ALUMNI,
		severity: "inform",
		blurs: "none",
		defaultSetting: "warn",
		adultOnly: false,
		locales: [
			{
				lang: "en",
				name: "Top Chicken Alum",
				description:
					"Has held the Top Chicken crown at least once. Once a chicken, always a chicken.",
			},
		],
	},
	{
		identifier: LABEL_GRANDMASTER,
		severity: "inform",
		blurs: "none",
		defaultSetting: "warn",
		adultOnly: false,
		locales: [
			{
				lang: "en",
				name: "TipTop Chicken 👑",
				description:
					"Holder of the highest all-time Top Chicken score — the single most-liked crowning ever. Moves only when the record is broken.",
			},
		],
	},
] as const;
