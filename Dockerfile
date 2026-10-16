# Use Node.js 24 base image (official AWS Lambda base)
FROM public.ecr.aws/lambda/nodejs:24

# Set working directory
WORKDIR /var/task

# Copy package files first
COPY package*.json ./

# Install only production dependencies
# `npm ci` installs exactly what package-lock.json pins (npm install may drift from it).
RUN npm ci --omit=dev --legacy-peer-deps

# Copy all project files
COPY . .

# Command for Lambda to run your handler
CMD ["index.handler"]