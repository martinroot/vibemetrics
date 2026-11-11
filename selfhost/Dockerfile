FROM python:3.12-slim
RUN groupadd --system vibemetrics && useradd --system --gid vibemetrics vibemetrics \
    && install -d -o vibemetrics -g vibemetrics /var/lib/vibemetrics /opt/vibemetrics/web \
    && python -m pip install --no-cache-dir maxminddb==3.2.0
WORKDIR /opt/vibemetrics
COPY selfhost/ ./selfhost/
COPY index.html ./web/
COPY assets/ ./web/assets/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER vibemetrics
EXPOSE 8080
CMD ["python", "selfhost/app.py"]
