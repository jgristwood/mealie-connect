# Mealie Connect Design Principles

## Product identity

Mealie Connect is a consumer cooking application, not an administration dashboard.

The interface should feel like a polished modern cooking product.

Think:

- premium recipe application
- editorial food magazine
- modern productivity app
- warm
- inviting
- sophisticated
- calm
- highly usable

The product should make the user feel like they are entering their cooking space, not managing an API.

---

## Visual hierarchy

The visual hierarchy must prioritize:

1. Recipes and food
2. Recipe discovery
3. Cooking actions
4. Meal planning
5. Shopping lists
6. Recipe importing
7. Account/server infrastructure

The Mealie server connection, API token user, server URL, saved accounts, and connection information are infrastructure.

Infrastructure information should NEVER visually dominate the main application experience.

---

## Visual style

Use:

- warm ivory/cream backgrounds
- dark charcoal/plum typography
- restrained purple/plum brand accents
- subtle warm neutrals
- strong typography
- generous but intentional whitespace
- high-quality recipe imagery
- subtle borders
- restrained shadows
- subtle transitions

The existing purple/plum brand identity should remain recognizable.

However, purple should be an accent rather than the dominant surface color.

---

## Avoid generic dashboard aesthetics

Do NOT make the application look like:

- an admin dashboard
- a SaaS analytics application
- a developer tool
- a Bootstrap template
- a generic Tailwind template
- an AI-generated dashboard

Avoid:

- excessive cards
- excessive rounded rectangles
- giant colored banners
- excessive gradients
- glassmorphism
- decorative blobs
- decorative circles
- neon colors
- excessive shadows
- excessive pills
- giant headings
- unnecessary borders
- excessive animation

Do not add visual decoration merely because it is fashionable.

Every visual element should have a purpose.

---

## Recipes are the product

Recipe content should be one of the strongest visual elements in the application.

When recipe imagery is available:

- use it prominently
- give it meaningful visual space
- create attractive recipe cards
- use photography as a source of visual richness

Recipe cards should feel editorial rather than like generic dashboard widgets.

Prefer:

- strong food imagery
- clear recipe titles
- subtle metadata
- restrained interaction states

Avoid tiny thumbnails whenever a larger image presentation would be appropriate.

The recipe experience should work well with:

- one recipe
- several recipes
- many recipes
- recipes without images

Do not create fake recipe data or fake imagery.

---

## Layout

Do not put every section inside a bordered card.

Use:

- whitespace
- alignment
- typography
- imagery
- grouping
- visual rhythm

to create hierarchy.

Cards should only be used when they provide a meaningful grouping or interaction.

Do not preserve an existing layout simply because it already exists.

If the current information architecture creates a poor visual hierarchy, redesign the layout while preserving functionality.

---

## Header

The header should be compact and confident.

The logo should feel like a brand mark rather than a large decorative element.

Navigation should prioritize the actual product features.

Do not make API/server information the visual focus of the header.

Mobile navigation should be intentionally designed rather than simply collapsed from desktop.

---

## Account and server information

Account and server information is secondary.

Users must still be able to:

- see the active account
- see the connected server
- switch saved accounts
- sign out

But this information should generally appear in:

- an account menu
- a settings area
- a compact connection indicator
- another secondary UI location

Do not create giant account/server banners on the main screen.

---

## Typography

Typography should feel editorial and sophisticated.

Create a clear hierarchy using:

- size
- weight
- line height
- spacing
- placement

Do not make every heading bold.

Do not use extremely large headings simply to make the interface look modern.

Body text should be comfortable to read.

Metadata should be visually quieter than primary content.

---

## Spacing

Use a consistent spacing system.

The interface should feel spacious but purposeful.

Avoid:

- cramped sections
- enormous unexplained empty areas
- arbitrary spacing
- inconsistent padding

Use CSS design tokens rather than scattered magic numbers.

---

## Components

Use reusable components when they establish consistent visual behavior.

Potential examples:

- AppHeader
- Navigation
- AccountMenu
- ConnectionStatus
- RecipeCard
- RecipeGrid
- FeaturedRecipe
- QuickAction
- ImportRecipe
- SectionHeader
- EmptyState
- LoadingState
- ErrorState

Do not create unnecessary abstractions.

---

## Color

Purple/plum should primarily communicate:

- brand identity
- primary actions
- active states
- selected states
- links
- important interactive elements

Do not use large purple surfaces simply for decoration.

The overall interface should remain warm and visually quiet.

---

## Motion

Use subtle interaction feedback:

- hover
- focus
- active
- loading
- navigation transitions
- recipe image transitions

Animations should be quick and restrained.

Respect:

`prefers-reduced-motion`

Do not animate everything.

---

## Accessibility

Maintain or improve:

- semantic HTML
- keyboard navigation
- visible focus states
- color contrast
- accessible labels
- screen-reader usability
- touch target sizes
- reduced-motion support

Never sacrifice accessibility for visual styling.

---

## Responsive design

Design intentionally for:

- mobile
- tablet
- laptop
- desktop

Do not simply shrink the desktop layout.

Recipe grids, navigation, forms, actions, and typography should adapt appropriately.

---

## Technical constraints

The project uses:

- React 19
- TypeScript
- Vite 8
- React Router DOM v7
- custom CSS
- Vite PWA
- custom Mealie REST API client
- Browser Fetch API
- LocalStorage persistence
- Node CORS proxy

Preserve this architecture.

Do not introduce:

- Tailwind
- Material UI
- Chakra
- Bootstrap

merely for visual styling.

Improve the existing custom CSS/design system instead.

Do not change:

- backend APIs
- authentication behavior
- Mealie connectivity
- LocalStorage behavior
- PWA behavior

unless explicitly requested.

---

## Design decision rule

When making a design decision, prioritize:

1. usability
2. visual hierarchy
3. consistency
4. readability
5. simplicity
6. product identity
7. visual polish

over novelty or trendiness.

If a design choice makes the application look more like a generic dashboard, do not use it.

---

## Final quality bar

Before considering UI work complete, ask:

"Does this look like a professionally designed cooking application?"

It should NOT look like:

"a developer dashboard with a purple theme."

Recipes and cooking should feel like the heart of the product.