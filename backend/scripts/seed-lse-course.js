/**
 * Phase 2c — publish the Liberia Stock Exchange course with its content.
 *
 * Writes the course copy and eighteen lessons (six modules), then the eight
 * question assessment on the final lesson. Everything is idempotent: re-running
 * replaces this course's lessons and quiz rather than duplicating them.
 *
 *   npm run seed:lse
 *
 * Publishing is deliberately NOT done here — it goes through the real admin
 * route afterwards, so the notification, the review record and the published
 * timestamp are produced the way the application produces them.
 *
 * Two rules were followed writing the prose:
 *   - every Liberian statement is structural (institutions, incentives, the state
 *     of the market) rather than a figure, because a figure cannot be verified
 *     from here and the academy does not publish claims it cannot stand behind.
 *   - the case study is labelled in the lesson as an invented teaching scenario,
 *     so nobody mistakes it for a report on a real company.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../src/db');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const Lesson = require('../src/models/Lesson');
const Quiz = require('../src/models/Quiz');
const { sanitizeLessonHtml } = require('../src/lib/sanitizeHtml');

const SLUG = 'liberia-stock-exchange';

const SUMMARY =
  'How a stock exchange works: shares and bonds, listing, trading, settlement, ' +
  'disclosure and the regulation that holds it together, with Liberia as the case in point.';

const DESCRIPTION = [
  'The Liberia Stock Exchange course explains how a stock exchange actually works, from the first principle to the practical detail, and uses Liberia\u2019s own market as the case in point.',
  '',
  'Across six modules it covers what a share is and how it differs from a bond; how an order becomes a trade; how a price is formed; how settlement and custody work; what a company must do to list and to stay listed; how an investor opens an account and reads a prospectus; how regulation and enforcement hold a market together; and what has to exist before a market like Liberia\u2019s can function at all.',
  '',
  'It closes with a plain assessment of the Liberian financial system as it stands, a worked case study of a mid-sized Liberian manufacturer deciding whether to list, and an eight-question assessment.',
  '',
  'This is an education course. It is not investment advice.',
].join('\n');

const LESSONS = [
  {
    title: 'Module 1 \u00b7 Why a stock exchange exists',
    summary: 'Companies need money they never repay. That only works if a stranger will buy your share.',
    minutes: 15,
    html: `
<p>A business that wants to grow needs money it does not have to hand back on a fixed date. A bank loan must be repaid whether the year went well or badly, and it usually must be repaid within a few years. That is a poor fit for a new processing plant, a rubber plantation that takes years to yield, or a distribution network that has to be built before it earns anything.</p>
<p>Equity solves the timing problem. An investor buys a share of the business and is repaid by the business succeeding, not by a schedule. If the company has a bad year, it does not owe the shareholder a payment. If it has a good decade, the shareholder does well alongside the founders.</p>
<p>But equity creates a second problem, and it is the one that stops most companies raising money this way. If you buy a share, how do you ever get your money back? You cannot ask the company to return it: the company has already spent it on the plant. You need somebody else to buy your share.</p>
<h3>The exchange solves the exit problem</h3>
<p>A stock exchange is where that second buyer is found. It does three things at once: it publishes a price everyone can see, it provides a rulebook both sides trust, and it turns the transfer of ownership into a routine administrative act rather than a private negotiation.</p>
<p>Once shares can be sold, a stranger will buy them. That is the whole trick. The company never has to repay anything; the investor simply sells to the next investor.</p>
<h3>What this means in Liberia</h3>
<p>Most Liberian businesses are financed from the owner\u2019s savings, from family, from retained earnings, or from short bank credit. Long-term capital is scarce, which is why many sound businesses stay the size they are. An exchange is one of the few mechanisms that can turn a saver\u2019s surplus into a company\u2019s permanent capital, provided the rest of the plumbing exists.</p>
<p>That plumbing is what the rest of this course is about.</p>
`,
  },
  {
    title: 'Module 1 \u00b7 Shares, bonds, and what a company actually sells',
    summary: 'Ownership and lending are different products with different rights. Confusing them is expensive.',
    minutes: 16,
    html: `
<p>Two very different things are sold on a stock exchange, and confusing them is one of the most common ways a new investor loses money.</p>
<h3>A share is ownership</h3>
<p>When you buy a share, you buy a fraction of the company itself. You are not lending to it. You own a piece of the plant, the stock, the contracts, the debts and the reputation, in proportion to the number of shares you hold.</p>
<p>That gives you a claim on whatever is left after everyone else has been paid. It usually gives you a vote at the general meeting, and a right to a dividend if the board declares one. Neither the dividend nor the price is promised. Both depend on how the business does.</p>
<h3>A bond is a loan</h3>
<p>When you buy a bond, you lend money on stated terms: a fixed amount, a fixed interest rate, and a date on which the money comes back. The bondholder is paid before the shareholder, every time. If the company fails, bondholders are settled first, and shareholders frequently receive nothing.</p>
<p>The flip side is the cap. A bondholder receives the interest and no more, however spectacularly the company performs. A shareholder has no cap at all, in either direction.</p>
<h3>Why a company would choose either</h3>
<p>Selling shares raises money the company never has to repay, but it sells part of the company itself. The founders of a family business may find that they now answer to strangers. Selling bonds keeps ownership intact, but it must be repaid on a schedule and it requires predictable cash flow.</p>
<p>Many companies use both. The point for a student of the market is simple: the price of a share is an opinion about a business, and the price of a bond is an opinion about a promise. They move for different reasons, and they belong in a portfolio for different reasons.</p>
`,
  },
  {
    title: 'Module 1 \u00b7 The four jobs of an exchange',
    summary: 'Price discovery, liquidity, capital allocation and discipline: what an exchange does, and what it does not.',
    minutes: 15,
    html: `
<p>It is tempting to think of an exchange as a building, or a screen full of prices. It is really a rulebook plus a set of services. Four of those services matter more than the rest.</p>
<h3>1. Price discovery</h3>
<p>An exchange produces a single, public price at which a willing buyer met a willing seller. Without it, every sale is a private negotiation and nobody knows whether they were treated fairly. A published price is also what makes collateral, tax and estate valuations possible at all.</p>
<h3>2. Liquidity</h3>
<p>Liquidity is the ability to sell without moving the price and without waiting. It is the reason a saver will accept shares instead of a fixed deposit. A market with many participants and a continuous order book is liquid. A market with three listed companies and one trade a month is not, and investors charge for that illiquidity in the price they are willing to pay.</p>
<h3>3. Capital allocation</h3>
<p>A functioning market moves money towards the businesses that can use it best, because investors can compare one against another on the same terms. That is the social argument for an exchange: it is a machine for directing savings towards productive use.</p>
<h3>4. Discipline</h3>
<p>A listed company must publish audited accounts, disclose material events, and treat all shareholders the same. It must answer questions in public. This is the benefit owners tend to underrate. Many companies discover that preparing to list improved the business more than the money did.</p>
<h3>What is left out</h3>
<p>An exchange does not guarantee that a company is good, that a price is fair, or that an investor will make money. It guarantees only that the rules were followed and the information was published. Judgement remains the investor\u2019s job, and it is the part no institution can do for you.</p>
`,
  },
  {
    title: 'Module 2 \u00b7 From order to trade: brokers, order books and matching',
    summary: 'Market orders, limit orders, spreads and why a thin market punishes impatience.',
    minutes: 18,
    html: `
<p>Almost nobody buys a share directly from another person. The path from a decision to a completed trade runs through a broker, an order book and a matching engine, and each step has a cost.</p>
<h3>The broker</h3>
<p>A broker is licensed to send orders to the market on your behalf and to hold your account. You open an account, complete identity checks, deposit money, and then instruct. In many small markets the number of licensed brokers is short, which is itself a limit on how many people can participate.</p>
<h3>The two order types</h3>
<p>A <strong>market order</strong> says: buy now, at whatever the best available price is. It executes quickly and the price is not guaranteed.</p>
<p>A <strong>limit order</strong> says: buy, but never above a price you name. The price is guaranteed and the execution is not.</p>
<p>Beginners often use market orders on shares that trade rarely, and are surprised by what they pay. On a thin market the difference between the best price and the next one can be large.</p>
<h3>The order book</h3>
<p>The order book is the list of every waiting buy and sell order, sorted by price. The gap between the highest bid and the lowest offer is the spread. A wide spread is a warning: it is the price of impatience in an illiquid market, and you pay it twice, once when you buy and once when you sell.</p>
<h3>An illustration</h3>
<p>Suppose the best offer is $2.00 for 500 shares and the next is $2.15 for 2,000. A market order for 1,000 shares fills 500 at $2.00 and 500 at $2.15. A limit order at $2.05 fills nothing until somebody is willing to sell at $2.05, which may be never.</p>
<p>Neither order is wrong. They answer different questions: how quickly, and at what price.</p>
`,
  },
  {
    title: 'Module 2 \u00b7 Price discovery: why a share is worth what it is worth',
    summary: 'Earnings, growth, the alternative, and what a price-to-earnings ratio really says.',
    minutes: 20,
    html: `
<p>A share price is not a fact about a company. It is the price at which the last buyer and seller agreed, which is an opinion about the company\u2019s future. Understanding what feeds that opinion is most of the work of investing.</p>
<h3>Three ingredients</h3>
<p><strong>Earnings.</strong> What the business earns, and how reliably. A company earning steadily from long contracts is worth more than one earning the same amount from a single client who might leave.</p>
<p><strong>Growth.</strong> Whether those earnings are likely to be larger next year. A business growing quickly is worth more, per dollar of today\u2019s profit, than one that is flat.</p>
<p><strong>The alternative.</strong> What the money could earn elsewhere. This is why interest rates matter so much. When a safe deposit pays well, a risky share must offer more to attract anyone at all.</p>
<h3>The price-to-earnings ratio</h3>
<p>Divide the share price by earnings per share. A company earning $2.00 per share and trading at $12.00 has a P/E of 6. Read plainly, buyers are paying six dollars for every one dollar of current annual profit.</p>
<p>A low P/E can mean the market expects decline, distrusts the accounts, or simply has not noticed the company. A high P/E means the market expects growth and has already paid for it. Neither number is a recommendation. The ratio becomes useful when compared with the company\u2019s own history and with its peers.</p>
<h3>What moves a price</h3>
<p>New information: a contract won, a director resigning, a regulator\u2019s decision, a shortage of the raw material. Also, less rationally, the arrival of many new buyers at once, or a persuasive message on social media.</p>
<p>On a small market the second category can move a price much further than the first. That is why this course keeps returning to disclosure: the more information is public and equally available, the more a price reflects the business rather than somebody\u2019s rumour.</p>
`,
  },
  {
    title: 'Module 2 \u00b7 Settlement, custody and why the money arrives later',
    summary: 'T+2, delivery versus payment, and the depository that decides whether a market scales.',
    minutes: 18,
    html: `
<p>A trade and a transfer are not the same event. The trade is an agreement; settlement is the moment the shares and the money actually move. The gap between them is where a great deal of market infrastructure exists.</p>
<h3>T plus two</h3>
<p>Most markets settle two business days after the trade, written T+2. On Monday you agree to buy; on Wednesday the shares appear in your account and the money leaves. The delay exists because the checks involved take time: confirming the order, confirming the parties, confirming that the shares are really owned by the person selling them.</p>
<h3>Settlement risk</h3>
<p>If shares were delivered before payment, the buyer could vanish and keep them. If payment came first, the seller could vanish and keep the money. The infrastructure answer is delivery versus payment: the two sides of a transaction are linked so neither can complete without the other.</p>
<h3>The central securities depository</h3>
<p>In an older market, a share is a paper certificate in a drawer. Moving it means moving paper, and proving ownership means examining a signature. A central securities depository replaces paper with an electronic register: it records who owns what, and a transfer is a bookkeeping entry.</p>
<p>This sounds like a technicality. It is not. Without a depository, a market cannot reliably answer the simplest question an investor asks: who owns this share? Paper also makes fraud, loss and forgery routine problems rather than exceptional ones.</p>
<h3>Why this matters for a new market</h3>
<p>When a country builds a stock exchange, the exchange is the visible part. The depository, the settlement rules and the licensing of intermediaries are the parts that decide whether it works.</p>
<p>A market that cannot settle quickly and safely will not attract the long-term money that listing companies need, however impressive the trading screen looks.</p>
`,
  },
  {
    title: 'Module 3 \u00b7 Should your company list?',
    summary: 'The gains, the losses, and the question that actually decides it.',
    minutes: 20,
    html: `
<p>Listing is a decision about the kind of company you want to run, not only about raising money. It is worth being blunt about both sides.</p>
<h3>What you gain</h3>
<p><strong>Permanent capital.</strong> Money that does not have to be repaid on a date. For a business with long projects, this is the difference between surviving a bad year and being sold by a receiver.</p>
<p><strong>A public valuation.</strong> Shares become something with a price, which makes them useful for paying staff, rewarding a management team, or letting a founding family sell gradually instead of all at once.</p>
<p><strong>Profile and discipline.</strong> Listed companies are examined. Customers, lenders and partners treat audited accounts differently from accounts prepared for the tax office.</p>
<h3>What you give up</h3>
<p><strong>Privacy.</strong> Your margins, your customers and your directors\u2019 pay become public.</p>
<p><strong>Control.</strong> New shareholders vote. Above a certain level of ownership, a company can change hands without the founders agreeing to it.</p>
<p><strong>Time and money.</strong> Advisers, audit, investor relations and reporting are permanent costs, paid whether the year was good or bad.</p>
<p><strong>Short-term pressure.</strong> Public owners often judge a business every quarter, while the business itself may think in five-year cycles.</p>
<h3>The question that decides it</h3>
<p>Not \u201ccan we list?\u201d but \u201cis the business ready to be examined?\u201d A company whose records are in order, whose board can hold management to account, and whose revenue does not depend on one customer will survive the process and benefit from it. A company that is not ready will spend money discovering that.</p>
<p>For many family-owned businesses the honest answer is: not yet, and here is the two-year plan that gets us there. The next lesson is what that plan contains.</p>
`,
  },
  {
    title: 'Module 3 \u00b7 The listing process, step by step',
    summary: 'Preparation, advisers, due diligence, the prospectus, review, pricing and admission.',
    minutes: 20,
    html: `
<p>The details differ from country to country, and the rules of any market are always the ones its regulator publishes, not the ones in a course. The shape of the process, however, is remarkably consistent.</p>
<h3>1. Preparation</h3>
<p>Audited accounts covering several years, a board with independent members, an audit committee, and a clear answer to what the money is for. Companies usually discover their real problems here, which is the point of starting early.</p>
<h3>2. Advisers</h3>
<p>A sponsor or issue house that takes responsibility for bringing the company to the market, a reporting accountant, and legal counsel. In smaller markets this group is thin, and a shortage of advisers is often the real constraint on how many companies can list at all.</p>
<h3>3. Due diligence</h3>
<p>The advisers examine the business: contracts, title to land and plant, tax history, litigation, dealings with related parties. Anything that will have to be disclosed has to be found first.</p>
<h3>4. The prospectus</h3>
<p>A disclosure document describing the business, its risks, its financial history, its directors and the terms of the offer. It exists so that a stranger can make an informed decision, and it is the document the company remains answerable for afterwards.</p>
<h3>5. Regulatory review</h3>
<p>The regulator reads the prospectus and asks questions, usually over several rounds. Approval is not an endorsement of the investment.</p>
<h3>6. Marketing and pricing</h3>
<p>The company meets investors and the price is set, either at a fixed price or through a bookbuilding process that records the demand at each level.</p>
<h3>7. Admission</h3>
<p>The shares are admitted, recorded in the depository and traded from the first day. That day is a beginning, not an ending: the obligations begin then and do not stop.</p>
`,
  },
  {
    title: 'Module 3 \u00b7 Life after listing: disclosure, investor relations and the cost of being public',
    summary: 'The obligations that do not end, and why silence is expensive.',
    minutes: 18,
    html: `
<p>The listing day is the easiest day. What follows is a permanent set of obligations, and a company that has not planned for them will come to resent them.</p>
<h3>Continuing obligations</h3>
<p>Periodic reporting: annual audited accounts, and usually half-year or quarterly results. Disclosure of inside information as soon as it is known, not when it is convenient. Rules for transactions with directors or major shareholders, so that value cannot quietly be moved to the people who run the company. Shareholder meetings with proper notice and proper minutes.</p>
<p>None of this is optional, and most of it answers one question: are outside shareholders being told what insiders know?</p>
<h3>Investor relations</h3>
<p>Markets reward companies that explain themselves. A short, honest annual letter and a willingness to take questions at the general meeting matter more than glossy brochures. Companies that treat disclosure as a burden tend to be valued at a discount, because investors assume the silence is hiding something.</p>
<h3>The short-term problem</h3>
<p>Public ownership brings pressure to produce a good number every period. That pressure is real, and it can tempt a management team to cut maintenance, delay a necessary investment, or smooth earnings. The defence is a board and a shareholder base that understand the business cycle and say so publicly.</p>
<h3>The reputation asset</h3>
<p>A listed company in a small market is unusually visible. That cuts both ways. A well-run company receives access and trust its unlisted competitors cannot buy; a badly run one finds its failures remembered for years.</p>
<p>In markets where information is scarce, reputation is a form of capital in its own right.</p>
`,
  },
  {
    title: 'Module 4 \u00b7 Opening an account and reading a prospectus',
    summary: 'Who may sell you shares, and the four sections of a prospectus worth reading first.',
    minutes: 18,
    html: `
<p>Before any of the analysis in this course matters, an investor needs a way to buy, and a document to read.</p>
<h3>The account</h3>
<p>Shares are bought through a licensed intermediary, never directly from the company. You open an account, provide identification and proof of address, and deposit money. The intermediary must be licensed by the regulator, and checking that licence is the first thing an investor should do in any country. Ask which regulator supervises them, then verify it independently.</p>
<p>In a market that is still being built, the practical first move is to ask the central bank and the finance ministry which intermediaries are currently authorised, rather than assuming a well-designed website is legitimate.</p>
<h3>What a prospectus contains</h3>
<p><strong>The business.</strong> What it does, where, for whom, and how it makes money.</p>
<p><strong>Risk factors.</strong> The company\u2019s own list of what could go wrong. It is usually the most honest few pages in the document.</p>
<p><strong>Financial history.</strong> Audited results, the accounting policies used, and the debts.</p>
<p><strong>Use of proceeds.</strong> What the money will be spent on. A company that cannot say precisely is telling you something.</p>
<p><strong>Management and governance.</strong> Who runs it, who oversees them, and how they are paid.</p>
<p><strong>The offer itself.</strong> How many shares, at what price, and whether existing owners are selling into it. That last point matters: money raised for the company builds the business, while money raised for a selling shareholder goes into their pocket.</p>
<h3>How to read it quickly</h3>
<p>Start with the risk factors and the use of proceeds, then the cash flow statement, then the related-party transactions. If those four sections are clear and unembarrassed, the rest of the document is worth reading properly.</p>
`,
  },
  {
    title: 'Module 4 \u00b7 Reading a company\u2019s numbers without an accounting degree',
    summary: 'Six numbers, one worked example, and the profit that never became cash.',
    minutes: 22,
    html: `
<p>You do not need to be an accountant to judge a business, but you do need six numbers and a willingness to compare them across several years.</p>
<h3>Six numbers</h3>
<p><strong>Revenue.</strong> Is it growing, flat or falling, and why?</p>
<p><strong>Gross margin.</strong> Revenue minus the direct cost of producing what was sold, as a percentage. A margin that falls while revenue rises usually means the company is buying growth with discounts.</p>
<p><strong>Operating profit.</strong> What is left after running the business. Compare it with revenue over time: a shrinking margin is a warning even while profit grows.</p>
<p><strong>Cash from operations.</strong> The line most beginners skip. Profit is an accounting result; cash is what pays wages.</p>
<p><strong>Debt.</strong> How much, at what rate, and when it must be repaid. A business can be profitable and still fail because a loan matures in a bad year.</p>
<p><strong>Receivables.</strong> Money owed by customers. If receivables grow faster than revenue, the company may be selling to people who do not pay.</p>
<h3>An illustration</h3>
<p>A company reports revenue of $1,000,000 and profit of $120,000, which looks healthy. But cash from operations is negative $80,000, and receivables rose from $100,000 to $400,000. The profit exists on paper while the cash sits with customers who have not paid.</p>
<p>That company needs financing to survive a good year, which is the most dangerous kind of problem because the headline numbers look fine.</p>
<h3>Then add the local conditions</h3>
<p>Liberian businesses often earn in both Liberian and United States dollars, and the mix matters. A company whose costs are in one currency and whose revenue is in the other carries a risk that a single set of accounts can hide.</p>
<p>Ask which currency the figures are reported in, and whether the margin survives a change in the exchange rate.</p>
`,
  },
  {
    title: 'Module 4 \u00b7 Risk, diversification and the mistakes beginners make',
    summary: 'Permanent loss is the enemy, not movement, and the five mistakes that cost the most.',
    minutes: 18,
    html: `
<p>Risk is not the same thing as movement. A share that wobbles daily but recovers is not the same as one that falls and never comes back. What an investor is trying to avoid is permanent loss, not the appearance of turbulence.</p>
<h3>Diversification</h3>
<p>Owning one company means its failure is your failure. Owning ten companies across different industries means one failure is a bad year rather than a catastrophe. A common rule of thumb keeps any single holding under about five percent of a portfolio. It is not a law, but it captures the idea that no single judgement should be able to ruin you.</p>
<p>Diversification has a limit worth understanding. Companies in the same country share a currency, a government and a banking system, so a national crisis can move all of them at once. Investors in small markets often need to think about diversifying across countries, not only across companies.</p>
<h3>The mistakes that cost the most</h3>
<p><strong>Acting on tips.</strong> If you did not have to work for the information, somebody else had it first.</p>
<p><strong>Borrowing to invest.</strong> Leverage turns a temporary fall into a permanent one, because the loan still has to be repaid at the worst moment.</p>
<p><strong>Investing money you will need soon.</strong> A share is not a savings account. If the money is for school fees next term, the market\u2019s timing is not yours.</p>
<p><strong>Ignoring costs.</strong> Commission and a wide spread are paid whether or not the investment works.</p>
<p><strong>Confusing a good company with a good price.</strong> The best business in the country can be a poor investment if you pay too much for it.</p>
<h3>A note on advice</h3>
<p>This course teaches how markets work. It is not investment advice, and it cannot be: the right decision depends on someone\u2019s obligations, circumstances and time horizon.</p>
<p>What the course can do is make you harder to mislead.</p>
`,
  },
  {
    title: 'Module 5 \u00b7 Who protects the investor, and how',
    summary: 'Disclosure, conduct and enforcement, and the one protection that matters most.',
    minutes: 18,
    html: `
<p>No market survives long without trust, and trust is not a personality trait of a market. It is a set of rules that are actually enforced.</p>
<h3>Three layers</h3>
<p><strong>Disclosure.</strong> Companies must publish what matters, when it matters. These rules do not judge whether a business is good; they ensure that a buyer can find out what the insiders know.</p>
<p><strong>Conduct.</strong> Intermediaries must be licensed, must keep client money separate from their own, must not trade ahead of their clients, and must be able to show what they did and on whose instruction.</p>
<p><strong>Enforcement.</strong> This is the layer that decides whether the other two mean anything. A regulator with clear disclosure rules and no power to sanction anybody has produced paperwork, not protection.</p>
<h3>Segregation of client assets</h3>
<p>The single most important protection for a small investor is that their shares and cash are held separately from the broker\u2019s own. If the broker fails, client assets should be returned rather than shared among creditors.</p>
<p>Ask any intermediary, in any country, where client assets are held and who audits that arrangement.</p>
<h3>What regulation cannot do</h3>
<p>It cannot make a bad business good, stop a share falling, or replace judgement. A well-regulated market still contains companies that fail and investors who lose money.</p>
<p>The purpose of regulation is narrower and more valuable: to make sure a loss happens because the business failed, not because somebody lied.</p>
<h3>In a market under construction</h3>
<p>Where the institutions are new, the practical question is not only what the rules say but who enforces them, and how quickly. Put that question to the regulator and the central bank directly, and weigh the answer the way you would weigh any other risk.</p>
`,
  },
  {
    title: 'Module 5 \u00b7 Market abuse: insider dealing and manipulation',
    summary: 'Why insider dealing damages everybody, and why thin markets are easier to rig.',
    minutes: 18,
    html: `
<p>Two kinds of behaviour damage a market more than any other, because both attack the premise that everyone is playing by the same rules.</p>
<h3>Insider dealing</h3>
<p>Someone who knows something material and not yet public buys or sells on it, or passes it to somebody who does. A director who sells before a bad result is announced is the classic example.</p>
<p>The harm is not mainly to the person on the other side of that trade. It is to the market\u2019s credibility. If participants believe the insiders always trade first, they conclude that public information is worthless, and they either stop investing or demand a discount on everything. Investors withdraw, and the companies that need capital pay more for it.</p>
<h3>Manipulation</h3>
<p><strong>Wash trading:</strong> buying and selling to yourself to create the appearance of activity.</p>
<p><strong>Spoofing:</strong> placing orders you intend to cancel, to move the price somebody else can see.</p>
<p><strong>Ramping, or pump and dump:</strong> accumulating a thin stock, talking it up, and selling into the buyers you attracted. Social media has made this cheap and fast.</p>
<p>All three work best in small, illiquid markets where a modest amount of money can move a price. That is an uncomfortable truth for a market like Liberia\u2019s: the same thinness that makes a new exchange fragile also makes abuse easier and more damaging.</p>
<h3>Defences</h3>
<p>Disclosure of directors\u2019 dealings. Rules requiring anyone crossing a shareholding threshold to declare it. Surveillance of trading patterns by the exchange and the regulator.</p>
<p>And, in practice, a culture in which an investor who sees something odd reports it rather than joining in.</p>
`,
  },
  {
    title: 'Module 5 \u00b7 Building a market from nothing',
    summary: 'Seven pieces that must exist at once, and the sequencing that usually works.',
    minutes: 20,
    html: `
<p>A stock exchange is not a single institution that can be bought and switched on. It is the meeting point of several things that must all exist at once, and the usual failure is to build one of them and expect the rest to follow.</p>
<h3>The seven pieces</h3>
<p><strong>Issuers</strong> with audited accounts and a reason to give up some ownership. <strong>Investors</strong> with money to commit for years rather than weeks. <strong>Intermediaries</strong> licensed to advise and to trade. <strong>Infrastructure</strong>: the exchange, the matching system, the depository, the settlement process. <strong>A regulator</strong> with disclosure rules and the power to enforce them. <strong>Legal and tax certainty</strong>, so that ownership, collateral and insolvency are predictable. And <strong>a reason for a company to list</strong>, which is usually a tax or capital treatment that makes the market worth the disclosure.</p>
<h3>The sequencing that tends to work</h3>
<p>Start with government securities. A sovereign bond market gives the country a yield curve, gives banks something to hold, and gives the depository and settlement system practice with instruments simpler than shares. Corporate bonds usually come next, then equities.</p>
<p>This order is not an accident. Each stage builds the plumbing and the habits the next one needs.</p>
<h3>The number problem</h3>
<p>A market with three listed companies is fragile: too few shares to trade, too few buyers to set a price, and one order can move everything. Depth comes from having many issuers, and many issuers only appear when listing is cheaper and more useful than the alternatives.</p>
<h3>Domestic institutional demand</h3>
<p>The most reliable buyers in any market are domestic institutions: pension funds, insurers and collective investment schemes, obliged to hold assets for decades. Without them, a small exchange depends on foreign money that leaves at the first sign of trouble.</p>
<p>Regional integration is the other route. A group of small national markets can sometimes do together what none of them can do alone.</p>
`,
  },
  {
    title: 'Module 6 \u00b7 The Liberian financial system today',
    summary: 'A bank-led, dollarised, largely informal economy, and what that means for a capital market.',
    minutes: 22,
    html: `
<p>This module turns the theory towards Liberia. It is written the way a careful professional would speak: describing structure and incentives, and leaving out any figure that cannot be checked today.</p>
<h3>A bank-led system</h3>
<p>Liberia\u2019s formal financial sector is dominated by commercial banks supervised by the Central Bank of Liberia. Those banks are the main source of formal credit, and the credit they supply is mostly short-dated. The Ministry of Finance and Development Planning manages fiscal policy, and the Liberia Revenue Authority collects tax.</p>
<p>Two features shape everything else. The economy is heavily dollarised, with United States dollars circulating alongside Liberian dollars, so businesses and savers think in two currencies at once. And a large part of economic activity is informal, which means many capable businesses have no audited accounts and no documented history a market could rely on.</p>
<h3>What that means for a stock exchange</h3>
<p>A capital market needs three things a bank-led, largely informal economy does not automatically provide: companies whose accounts can be trusted, savers willing to lock money away for years, and intermediaries able to price and settle a trade.</p>
<p>Remittances are a large source of household income, but they arrive as consumption and short-term saving rather than long-term investment capital. The large corporates in mining, rubber and agriculture are mostly foreign-owned and financed abroad. The businesses that might genuinely want domestic equity are mid-sized and family-owned, which is both the opportunity and the difficulty.</p>
<h3>The honest position</h3>
<p>A capital market in Liberia is something being built, not something finished. Anyone who tells you otherwise, whether they are selling a listing or an investment, is selling something.</p>
<p>The responsible questions are: what are the current listing rules, who is licensed to intermediate, where are client assets held, and which institution supervises the market today? Ask the central bank and the ministry directly, and treat the answer as the beginning of your research rather than the end of it.</p>
`,
  },
  {
    title: 'Module 6 \u00b7 Case study: a Monrovia manufacturer weighs a listing',
    summary: 'A worked scenario: is the business ready to be examined, and what would a prospectus have to disclose?',
    minutes: 25,
    html: `
<blockquote>This is a teaching scenario, not a report on a real company. The business, its numbers and its owners are invented, to show how the decisions in this course fit together.</blockquote>
<h3>The company</h3>
<p>Kpelle Agro Processing has milled rice and packaged cassava flour outside Gbarnga for twelve years. It is owned by two brothers and their families, employs about sixty people seasonally, and reports revenue of roughly $1.2 million a year. Its largest customer, a Monrovia distributor, accounts for around two fifths of sales.</p>
<h3>The question</h3>
<p>Demand is outgrowing the plant. A second mill and a drying facility would cost about $2.5 million. The bank has offered a three-year loan at a rate the brothers privately consider unsustainable, secured on family land, in United States dollars while much of their revenue is in Liberian dollars.</p>
<h3>What the course says to ask</h3>
<p><strong>Is the business examinable?</strong> No. The accounts are prepared for tax rather than for a stranger. The land for one site is leased from a cousin on terms that exist only in conversation. There is no independent board.</p>
<p><strong>What would a prospectus have to disclose?</strong> The customer concentration, the related-party lease, the seasonality of the harvest, and the currency mismatch between dollar debt and local revenue. Each is a risk factor an investor would price, and each is fixable.</p>
<p><strong>What is the money for?</strong> Equipment, not working capital. That is the good answer. A listing to fund a permanent shortfall in cash would only postpone a problem.</p>
<h3>The decision</h3>
<p>The brothers do not list this year. They spend eighteen months on three things: audited accounts, a lease on commercial terms, and an independent director with food-processing experience. They take a smaller bank facility in the meantime, and begin meeting advisers about a listing in three years, when the second plant is running and the numbers can be compared across several years.</p>
<h3>Why this is the right answer</h3>
<p>Not because listing is wrong, but because the sequence matters. The discipline a market imposes is the product being bought. Arriving early means paying for it without being ready to survive it.</p>
`,
  },
  {
    title: 'Module 6 \u00b7 Final assessment',
    summary: 'Eight questions across the whole course, and what to do with the material afterwards.',
    minutes: 15,
    html: `
<p>You have reached the end of the course. What follows is a short assessment, and then some advice on what to do with the material.</p>
<h3>What the assessment covers</h3>
<p>Eight questions, drawn from every module. A few test definitions, because precision matters when you are reading a prospectus or a broker\u2019s terms. A few test judgement, in the way that the wrong answer is often the one that sounds most confident.</p>
<p>You can attempt it as often as you like. The pass mark is seventy percent, which is low enough to allow one or two careless mistakes and high enough that guessing will not carry you through.</p>
<h3>What to do afterwards</h3>
<p><strong>Read one real prospectus.</strong> Any market, any company, any country: these documents are public. The point is not to evaluate that company, it is to recognise the shape of the document when you meet one you care about.</p>
<p><strong>Name three companies you would like to see listed</strong> in Liberia, and write one sentence for each on what would have to be true for a stranger to buy shares in it. That exercise is worth more than any amount of reading about market structure.</p>
<p><strong>Find out what is actually true today.</strong> Ask the central bank and the Ministry of Finance and Development Planning for the current state of the market and the rules that apply. Institutions change; a course cannot keep up with them, and it should not pretend to.</p>
<h3>A last caution</h3>
<p>This course is education, not advice. It has tried to teach you how the machinery works and where the risks genuinely sit. What you do with that is a decision about your own circumstances, and it deserves more care than any course, including this one, can give it.</p>
`,
  },
];

/** The assessment, attached to the final lesson. */
const QUESTIONS = [
  {
    prompt: 'When you buy a share of a company, what have you bought?',
    explanation:
      'A share is ownership of a fraction of the company. You are not a lender, and the company owes you no scheduled repayment.',
    options: [
      { text: 'A fraction of ownership in the company', correct: true },
      { text: 'A loan to the company, repayable on a fixed date', correct: false },
      { text: 'A fixed rate of interest for a fixed period', correct: false },
      { text: 'A guarantee that the company will pay a dividend', correct: false },
    ],
  },
  {
    prompt: 'Which of these is a bondholder entitled to that a shareholder is not?',
    explanation:
      'A bond sets out a schedule of payments and a repayment date. A shareholder has a claim on whatever is left, which may be nothing.',
    options: [
      { text: 'A stated schedule of interest and repayment', correct: true },
      { text: 'A vote at the general meeting', correct: false },
      { text: 'A share of the profits', correct: false },
      { text: 'The right to sell to another investor', correct: false },
    ],
  },
  {
    prompt: 'A trade settles "T+2". What does that mean?',
    explanation:
      'The trade is agreed on day T and the shares and money change hands two business days later, after the order, the parties and the ownership have been confirmed.',
    options: [
      { text: 'The shares and money move two business days after the trade', correct: true },
      { text: 'Two trades are allowed per day', correct: false },
      { text: 'There is a two-day period in which to cancel the trade', correct: false },
      { text: 'The broker charges two percent', correct: false },
    ],
  },
  {
    prompt: 'You place a limit order to buy at $2.00. Which statement is correct?',
    explanation:
      'A limit order sets the worst price you will accept. It can fill at $2.00 or lower, and it may never fill at all.',
    options: [
      { text: 'It will only execute at $2.00 or lower, and may not execute at all', correct: true },
      { text: 'It will execute immediately at the best available price', correct: false },
      { text: 'It guarantees a fill, but not a price', correct: false },
      { text: 'It executes at exactly $2.00, no other price is possible', correct: false },
    ],
  },
  {
    prompt:
      'A company earns $200,000 after tax, has 100,000 shares in issue, and the shares trade at $6.00. What is the price-to-earnings ratio?',
    explanation:
      'Earnings per share are $200,000 divided by 100,000 shares, which is $2.00. Dividing the $6.00 price by $2.00 gives a P/E of 3.',
    options: [
      { text: '3', correct: true },
      { text: '6', correct: false },
      { text: '12', correct: false },
      { text: '30', correct: false },
    ],
  },
  {
    prompt: 'Why does a central securities depository matter to an investor?',
    explanation:
      'It records ownership electronically and makes a transfer a bookkeeping entry, which removes the fraud, loss and delay that come with paper certificates.',
    options: [
      { text: 'It records who owns what, so shares can transfer without paper', correct: true },
      { text: 'It decides the price at which shares trade', correct: false },
      { text: 'It lends money to investors who want to buy more', correct: false },
      { text: 'It guarantees that the company will not fail', correct: false },
    ],
  },
  {
    kind: 'true_false',
    prompt: 'Insider dealing is only a problem because it can move the share price.',
    explanation:
      'The main damage is to confidence. If public information is believed to be worthless, investors withdraw or demand a discount on everything, and the cost falls on every company that needs capital.',
    options: [
      { text: 'True', correct: false },
      { text: 'False', correct: true },
    ],
  },
  {
    kind: 'true_false',
    prompt: 'Holding shares in several different companies reduces the damage if one of them fails.',
    explanation:
      'That is what diversification does. It does not remove risk: companies in the same country still share a currency, a government and a banking system.',
    options: [
      { text: 'True', correct: true },
      { text: 'False', correct: false },
    ],
  },
];

const MINUTES_PER_LESSON = (lesson) => (typeof lesson.minutes === 'number' ? lesson.minutes : 15);

async function main() {
  await db.connect();

  const course = await Course.findOne({ slug: SLUG });
  if (!course) throw new Error(`No course with slug "${SLUG}"`);

  /**
   * Re-seeding replaces every lesson, and lesson ids are what a student's
   * progress points at. Once anybody has worked through part of the course,
   * re-running would silently reset them to zero — so it refuses, and says why.
   *
   * `--force` is for the case where the content really is being rewritten and
   * that is understood.
   */
  const started = await Enrollment.countDocuments({
    course: course._id,
    'completedLessons.0': { $exists: true },
  });

  if (started > 0 && !process.argv.includes('--force')) {
    throw new Error(
      `${started} enrolment(s) already have completed lessons. Re-seeding deletes every lesson and ` +
        'resets progress. Re-run with --force if that is what you want.'
    );
  }

  /**
   * Copy. The category was "technology", which put a capital-markets course in
   * the wrong filter of the catalog, and the summary described an organisation
   * rather than the course, so a browsing student learned nothing from the card.
   */
  course.summary = SUMMARY;
  course.description = DESCRIPTION;
  course.category = 'finance-accounting';
  course.level = 'beginner';
  course.tags = [
    'stock exchange',
    'capital markets',
    'investing',
    'listing',
    'liberia',
    'finance',
    'regulation',
  ];

  const removedLessons = await Lesson.deleteMany({ course: course._id });
  const removedQuizzes = await Quiz.deleteMany({ course: course._id });

  const created = [];

  for (const [index, lesson] of LESSONS.entries()) {
    const body = sanitizeLessonHtml(lesson.html);

    if (!body) throw new Error(`Lesson ${index + 1} sanitised to nothing`);

    const document = await Lesson.create({
      course: course._id,
      title: lesson.title,
      summary: lesson.summary,
      type: 'text',
      content: body,
      order: index + 1,
      durationMinutes: MINUTES_PER_LESSON(lesson),
      published: true,
    });

    created.push(document);
  }

  const lastLesson = created[created.length - 1];

  const quiz = await Quiz.create({
    lesson: lastLesson._id,
    course: course._id,
    title: 'Final assessment',
    passPercent: 70,
    // Unlimited: a fee has been paid for this course, and an arbitrary cap on
    // attempts would only punish somebody who is learning.
    maxAttempts: 0,
    questions: QUESTIONS.map((question, index) => ({
      prompt: question.prompt,
      kind: question.kind === 'true_false' ? 'true_false' : 'single',
      explanation: question.explanation,
      points: 1,
      order: index + 1,
      options: question.options.map((option) => ({ text: option.text, isCorrect: option.correct })),
    })),
  });

  /**
   * Counters, computed the same way the course route does it: published lessons
   * only, and duration rounded to one decimal place.
   */
  const published = await Lesson.find({ course: course._id, published: true }).select('durationMinutes');
  course.lessonCount = published.length;
  course.durationHours =
    Math.round((published.reduce((sum, item) => sum + (item.durationMinutes || 0), 0) / 60) * 10) / 10;

  await course.save();

  const words = created.map((lesson) => lesson.content.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).length);

  process.stdout.write(
    [
      `course    ${course.title} (${course.slug})`,
      `status    ${course.status}`,
      `category  ${course.category}`,
      `lessons   ${created.length} (removed ${removedLessons.deletedCount} old, ${removedQuizzes.deletedCount} quizzes)`,
      `hours     ${course.durationHours}`,
      `words     min ${Math.min(...words)}, max ${Math.max(...words)}, total ${words.reduce((a, b) => a + b, 0)}`,
      `quiz      ${quiz.questions.length} questions on "${lastLesson.title}"`,
      '',
      ...created.map((lesson, index) => `  ${String(index + 1).padStart(2)}. ${lesson.title}  [${words[index]} words, ${lesson.durationMinutes} min]`),
      '',
    ].join('\n')
  );

  await db.disconnect();
}

main().catch(async (error) => {
  process.stderr.write(`${error.stack}\n`);
  try {
    await db.disconnect();
  } catch (ignored) {
    /* already closed */
  }
  process.exit(1);
});
