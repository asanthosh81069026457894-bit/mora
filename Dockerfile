# Use the official Bun image for a fast, modern runtime
FROM oven/bun:latest

# Set the working directory inside the container
WORKDIR /app

# Copy package files first to leverage Docker layer caching
COPY package.json bun.lock bunfig.toml* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy the rest of the application code
COPY . .

# Build the application (creates the .output folder for TanStack Start/Nitro)
RUN bun run build

# Expose the port Render expects (default is 10000, but we'll use the PORT env var)
EXPOSE 10000

# Start the production server
# We use 'bun run start' which we defined in package.json to run the Nitro server
CMD ["bun", "run", "start"]
