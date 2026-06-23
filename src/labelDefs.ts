/**
 * Label value definitions declared by this labeller.
 *
 * Format reference: https://docs.bsky.app/docs/advanced-guides/moderation#custom-label-values
 * These are passed to `declareLabeler` from @skyware/labeler to publish the
 * app.bsky.labeler.service record so the labels render with names/descriptions
 * in clients instead of as raw label values.
 */
import { LABEL_CURRENT, LABEL_ALUMNI } from "./config.js";

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
				name: "Top Chicken Alumnus 🏆",
				description:
					"Has held the Top Chicken crown at least once. Once a chicken, always a chicken.",
			},
		],
	},
] as const;
