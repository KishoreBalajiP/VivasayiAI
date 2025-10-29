# Use Node.js 20 base image (official AWS Lambda base)
FROM public.ecr.aws/lambda/nodejs:20

# Set working directory
WORKDIR /var/task

# Copy package files first
COPY package*.json ./

# Install only production dependencies
RUN npm install --production --legacy-peer-deps

# Copy all project files
COPY . .

# Command for Lambda to run your handler
CMD ["index.handler"]