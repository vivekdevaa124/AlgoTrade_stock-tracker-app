import { inngest } from "@/lib/inngest/client";
import { NEWS_SUMMARY_EMAIL_PROMPT, PERSONALIZED_WELCOME_EMAIL_PROMPT } from "@/lib/inngest/prompts";
import { sendNewsSummaryEmail, sendWelcomeEmail } from "@/lib/nodemailer";
import { getAllUsersForNewsEmail } from "@/lib/actions/user.actions";
import { getWatchlistSymbolsByEmail } from "@/lib/actions/watchlist.actions";
import { getNews } from "@/lib/actions/finnhub.actions";
import { getFormattedTodayDate } from "@/lib/utils";

// --- TYPE DEFINITIONS (Fixes TS2304) ---
export interface UserForNewsEmail {
    id: string;
    name: string;
    email: string;
}

export interface MarketNewsArticle {
    category: string;
    datetime: number;
    headline: string;
    id: number;
    image: string;
    related: string;
    source: string;
    summary: string;
    url: string;
}

// --- WELCOME EMAIL FUNCTION ---
export const sendSignUpEmail = inngest.createFunction(
    { id: 'sign-up-email' },
    { event: 'app/user.created'},
    async ({ event, step }) => {
        const userProfile = `
            - Country: ${event.data.country}
            - Investment goals: ${event.data.investmentGoals}
            - Risk tolerance: ${event.data.riskTolerance}
            - Preferred industry: ${event.data.preferredIndustry}
        `

        const prompt = PERSONALIZED_WELCOME_EMAIL_PROMPT.replace('{{userProfile}}', userProfile)

        const response = await step.ai.infer('generate-welcome-intro', {
            model: step.ai.models.gemini({ model: 'gemini-2.5-flash-lite' }),
            body: {
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            }
        })

        await step.run('send-welcome-email', async () => {
            const part = response.candidates?.[0]?.content?.parts?.[0];
            // Branding: AlgoTrade
            const introText = (part && 'text' in part ? part.text : null) || 'Thanks for joining AlgoTrade. You now have the tools to track markets and make smarter moves.'

            const { data: { email, name } } = event;
            return await sendWelcomeEmail({ email, name, intro: introText });
        })

        return { success: true, message: 'Welcome email sent successfully' }
    }
)

// --- DAILY NEWS SUMMARY FUNCTION ---
// --- DAILY NEWS SUMMARY FUNCTION ---
export const sendDailyNewsSummary = inngest.createFunction(
    { id: 'daily-news-summary' },
    [ { event: 'app/send.daily.news' }, { cron: '0 12 * * *' } ],
    async ({ step }) => {
        // Step #1: Explicitly cast to UserForNewsEmail[]
        const users = await step.run('get-all-users', getAllUsersForNewsEmail) as UserForNewsEmail[];

        if(!users || users.length === 0) return { success: false, message: 'No users found' };

        // Step #2: Explicit cast for the return value of step.run
        const results = await step.run('fetch-user-news', async () => {
            const perUser: Array<{ user: UserForNewsEmail; articles: MarketNewsArticle[] }> = [];

            for (const user of users) {
                try {
                    const symbols = await getWatchlistSymbolsByEmail(user.email);
                    let articles = await getNews(symbols);

                    // Ensure articles is at least an empty array before slicing
                    articles = (articles || []).slice(0, 6);

                    if (!articles || articles.length === 0) {
                        const fallbackArticles = await getNews();
                        articles = (fallbackArticles || []).slice(0, 6);
                    }

                    perUser.push({ user, articles: articles as MarketNewsArticle[] });
                } catch (e) {
                    console.error('daily-news error:', user.email, e);
                    perUser.push({ user, articles: [] });
                }
            }
            return perUser;
        }) as Array<{ user: UserForNewsEmail; articles: MarketNewsArticle[] }>; // CRITICAL: Fixes the 'results' red line

        // Step #3: Summarize via AI
        const userNewsSummaries: { user: UserForNewsEmail; newsContent: string | null }[] = [];

        // Now 'user' and 'articles' will be correctly typed because 'results' was cast above
        for (const { user, articles } of results) {
            try {
                const prompt = NEWS_SUMMARY_EMAIL_PROMPT.replace('{{newsData}}', JSON.stringify(articles, null, 2));

                const response = await step.ai.infer(`summarize-news-${user.email}`, {
                    model: step.ai.models.gemini({ model: 'gemini-2.5-flash-lite' }),
                    body: {
                        contents: [{ role: 'user', parts: [{ text: prompt }] }]
                    }
                });

                const part = response.candidates?.[0]?.content?.parts?.[0];
                const newsContent = (part && 'text' in part ? part.text : null) || 'No market news today.'
                userNewsSummaries.push({ user, newsContent });
            } catch (e) {
                console.error(`Failed to summarize news for ${user.email}:`, e);
                userNewsSummaries.push({ user, newsContent: null });
            }
        }

        // Step #4: Send emails
        await step.run('send-news-emails', async () => {
            await Promise.all(
                userNewsSummaries.map(async ({ user, newsContent }) => {
                    if(!newsContent) return false;
                    return await sendNewsSummaryEmail({
                        email: user.email,
                        date: getFormattedTodayDate(),
                        newsContent
                    });
                })
            )
        })

        return { success: true, message: 'Emails sent successfully' }
    }
);
